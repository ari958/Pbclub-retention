/**
 * Programming Agent routes — Phase 2 (shadow evaluation only).
 *
 * POST /api/programming/evaluate
 *   Run the shadow evaluator for a club. Returns 202 immediately, runs async.
 *   Body: { clubId: string, dryRun?: boolean }
 *
 * GET  /api/programming/evaluate/status
 *   Poll the evaluator job.
 *
 * GET  /api/programming/decisions?clubId=&limit=&offset=
 *   Decision log — list programming_decisions rows, newest first.
 *
 * GET  /api/programming/upcoming-risk?clubId=
 *   Current signup state for events whose checkpoints fire ≤72h from now,
 *   compared against each active rule. Read-only (no writes).
 *
 * POST /api/programming/backfill-fill
 *   Re-compute event_fill.final_signups using active signup counts for all
 *   existing rows. Body: { clubId: string, dryRun?: boolean }
 *   Returns 202; poll /api/programming/backfill-fill/status.
 *
 * POST /api/programming/backtest
 *   Replay a candidate rule spec against the last N days of event_fill history.
 *   Body: { clubId: string, rule: RuleSpec, days?: number }
 *   Returns synchronously (may be slow for large datasets).
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { supabase } from "../lib/supabaseClient";
import { runEvaluator, fetchActiveSignupCount } from "../lib/programmingEvaluator";
import { loadArchetypes, classifyEvent, isDailyPeak, isPeakSeason } from "../lib/classifyEvent";
import { batchComputePlayerTiming } from "../lib/playerTiming";
import { computeWarmScore } from "../lib/warmScore";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Job store (in-process; survives as long as the server is up) ──────────────

type JobStatus = "idle" | "running" | "done" | "error";

interface JobState {
  status: JobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  stats: Record<string, number> | null;
  error: string | null;
  logs: string[];
}

function makeJob(): JobState {
  return { status: "idle", startedAt: null, finishedAt: null, stats: null, error: null, logs: [] };
}

const JOB_EVAL          = "programming_evaluate";
const JOB_FILL_BACKFILL = "programming_fill_backfill";
const jobs: Record<string, JobState> = {
  [JOB_EVAL]:          makeJob(),
  [JOB_FILL_BACKFILL]: makeJob(),
};

function appendLog(jobKey: string, msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  const j = jobs[jobKey];
  if (!j) return;
  j.logs.push(line);
  if (j.logs.length > 500) j.logs.splice(0, j.logs.length - 500);
  logger.info({ job: jobKey }, line);
}

// ── POST /api/programming/evaluate ────────────────────────────────────────────

const EvalBodySchema = z.object({
  clubId: z.string().uuid(),
  dryRun: z.boolean().optional(),
});

router.post("/programming/evaluate", async (req, res) => {
  const parsed = EvalBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "clubId (uuid) required; dryRun optional boolean" }); return;
  }
  const { clubId, dryRun = false } = parsed.data;
  const j = jobs[JOB_EVAL];

  if (j.status === "running") {
    res.status(409).json({
      error: "Evaluator already running",
      startedAt: j.startedAt,
      recentLogs: j.logs.slice(-5),
    });
    return;
  }

  j.status = "running";
  j.startedAt = new Date().toISOString();
  j.finishedAt = null;
  j.stats = null;
  j.error = null;
  j.logs.length = 0;

  res.status(202).json({
    status: "started",
    dryRun,
    clubId,
    message: "Evaluator running in background. Poll GET /api/programming/evaluate/status.",
    startedAt: j.startedAt,
  });

  (async () => {
    try {
      const stats = await runEvaluator(clubId, (msg) => appendLog(JOB_EVAL, msg), { dryRun });
      j.status = "done";
      j.stats = stats as any;
    } catch (err: any) {
      j.status = "error";
      j.error = err.message;
      logger.error({ err }, "[programming/evaluate] evaluator failed");
    } finally {
      j.finishedAt = new Date().toISOString();
    }
  })();
});

// ── GET /api/programming/evaluate/status ──────────────────────────────────────

router.get("/programming/evaluate/status", (_req, res) => {
  const j = jobs[JOB_EVAL];
  res.json({
    status: j.status,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    stats: j.stats,
    error: j.error,
    recentLogs: j.logs.slice(-20),
  });
});

// ── GET /api/programming/queue ────────────────────────────────────────────────
//
// All open PROMOTE decisions for the club, enriched with candidate counts from
// promotion_candidates. Used by the operator queue screen (Phase 3.3 Item 4).
// Read-only.

router.get("/programming/queue", async (req, res) => {
  const clubId = req.query.clubId as string;
  if (!clubId) { res.status(400).json({ error: "clubId required" }); return; }

  const { data: decisions, error } = await supabase
    .from("programming_decisions")
    .select("id, event_id, event_name, event_start_time, signup_count, total_teams, evaluated_at, rule_name, checkpoint_offset_hours, approved_at")
    .eq("club_id", clubId)
    .eq("decision", "PROMOTE")
    .gt("event_start_time", new Date().toISOString())
    .order("event_start_time", { ascending: true });

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Enrich each decision with candidate counts
  const enriched = await Promise.all(
    (decisions ?? []).map(async (dec: any) => {
      const { data: cands } = await supabase
        .from("promotion_candidates")
        .select("eligible, reasons")
        .eq("decision_id", dec.id);
      const eligible    = (cands ?? []).filter((c: any) => c.eligible);
      const smsReach    = eligible.filter((c: any) => c.reasons?.sms_reachable === true);
      const hoursUntil  = (new Date(dec.event_start_time).getTime() - Date.now()) / 3_600_000;
      return {
        ...dec,
        hours_until_start:    Math.round(hoursUntil * 10) / 10,
        eligible_count:       eligible.length,
        sms_reachable_count:  smsReach.length,
        has_candidates:       (cands ?? []).length > 0,
      };
    }),
  );

  // ── Club-level 30-day channel stats ──────────────────────────────────────
  // This is the number that tells the operator whether the channel is being
  // over-used at a glance.  Empty ledger → 0s (expected before first send).
  const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
  let totalPromoContacts30d = 0;
  let distinctPlayersContacted30d = 0;
  try {
    const { data: statsRows } = await supabase
      .from("contact_ledger")
      .select("player_id")
      .eq("club_id", clubId)
      .eq("purpose", "promotion")
      .gte("sent_at", since30d);
    totalPromoContacts30d        = (statsRows ?? []).length;
    distinctPlayersContacted30d  = new Set((statsRows ?? []).map((r: any) => r.player_id)).size;
  } catch { /* ledger may not exist yet */ }

  res.json({
    queue: enriched,
    channel_stats: {
      total_promo_contacts_30d:   totalPromoContacts30d,
      distinct_players_contacted: distinctPlayersContacted30d,
      window_days: 30,
    },
  });
});

// ── PATCH /api/programming/decisions/:id/approve ──────────────────────────────
//
// Writes approved_at = now() on a PROMOTE decision.
// No-op if already approved (returns 200 with the existing timestamp).
// This is purely a schema gate — no Twilio call is made.

router.patch("/programming/decisions/:id/approve", async (req, res) => {
  const { id } = req.params;
  const clubId = req.query.clubId as string;
  if (!clubId) { res.status(400).json({ error: "clubId required" }); return; }

  // Verify the decision belongs to this club and is a PROMOTE
  const { data: dec, error: fetchErr } = await supabase
    .from("programming_decisions")
    .select("id, decision, approved_at, event_name")
    .eq("id", id)
    .eq("club_id", clubId)
    .maybeSingle();

  if (fetchErr) { res.status(500).json({ error: fetchErr.message }); return; }
  if (!dec)     { res.status(404).json({ error: "Decision not found" }); return; }
  if ((dec as any).decision !== "PROMOTE") {
    res.status(400).json({ error: "Only PROMOTE decisions can be approved" }); return;
  }

  // Idempotent — if already approved, return the existing timestamp
  if ((dec as any).approved_at) {
    res.json({ approved: true, approved_at: (dec as any).approved_at, id, already_approved: true });
    return;
  }

  const approvedAt = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("programming_decisions")
    .update({ approved_at: approvedAt })
    .eq("id", id)
    .eq("club_id", clubId);

  if (updateErr) { res.status(500).json({ error: updateErr.message }); return; }

  logger.info({ id, clubId, event_name: (dec as any).event_name }, "[programming/approve] decision approved");
  res.json({ approved: true, approved_at: approvedAt, id, already_approved: false });
});

// ── GET /api/programming/decisions ────────────────────────────────────────────
//
// Query params: clubId (uuid), scope (current|archived), limit (default 50), offset (default 0).
// Omit scope to retain the original all-decisions API for other consumers.

router.get("/programming/decisions", async (req, res) => {
  const clubId = req.query.clubId as string;
  if (!clubId) { res.status(400).json({ error: "clubId required" }); return; }

  const limit  = Math.min(parseInt(req.query.limit  as string || "50", 10), 200);
  const offset = parseInt(req.query.offset as string || "0",  10);
  const scope = req.query.scope as string | undefined;
  if (scope && scope !== "current" && scope !== "archived") {
    res.status(400).json({ error: "scope must be current or archived" }); return;
  }

  let query = supabase
    .from("programming_decisions")
    .select("*", { count: "exact" })
    .eq("club_id", clubId);
  const now = new Date().toISOString();
  if (scope === "current") query = query.gt("event_start_time", now);
  if (scope === "archived") query = query.lte("event_start_time", now);
  const { data, error, count } = await query
    .order("evaluated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ count, decisions: data ?? [] });
});

// ── GET /api/programming/upcoming-risk ────────────────────────────────────────
//
// Read-only snapshot of upcoming events vs. active rules. No writes.
// Returns events whose soonest checkpoint is ≤72h away.

router.get("/programming/upcoming-risk", async (req, res) => {
  const clubId = req.query.clubId as string;
  if (!clubId) { res.status(400).json({ error: "clubId required" }); return; }

  try {
    // Load club API config
    const { data: club, error: clubErr } = await supabase
      .from("clubs")
      .select("platform_api_key, platform_subdomain")
      .eq("id", clubId)
      .maybeSingle();
    if (clubErr || !club?.platform_subdomain) {
      res.status(500).json({ error: "Club not found or misconfigured" });
      return;
    }

    const apiKey  = club.platform_api_key ?? process.env.PODPLAY_API_KEY ?? "";
    const apiBase = `https://${club.platform_subdomain}.podplay.app/apis/v2`;

    // Load rules + archetypes
    const { data: rulesData, error: rulesErr } = await supabase
      .from("programming_rules")
      .select("id, name, enabled, match_rules, checkpoints, mode")
      .eq("club_id", clubId)
      .eq("enabled", true);
    if (rulesErr) { res.status(500).json({ error: (rulesErr as any).message ?? "rules error" }); return; }
    const rules = rulesData ?? [];

    const archetypes = await loadArchetypes(clubId);

    // Fetch upcoming events (next 96h from PodPlay)
    const now     = new Date();
    const horizon = new Date(now.getTime() + 96 * 3_600_000);
    const url =
      `${apiBase}/events?pageSize=100&page=1` +
      `&startTimeFrom=${encodeURIComponent(now.toISOString())}` +
      `&startTimeTo=${encodeURIComponent(horizon.toISOString())}`;

    const evRes = await fetch(url, { headers: { "x-api-key": apiKey } });
    if (!evRes.ok) { res.status(502).json({ error: `PodPlay API error: ${evRes.status}` }); return; }
    const evBody: any = await evRes.json();
    // Client-side guard: PodPlay startTimeTo is not strictly UTC-enforced. Apply both bounds.
    const allEvents: any[] = (evBody?.items ?? []).filter(
      (e: any) => e.startTime && new Date(e.startTime) > now && new Date(e.startTime) <= horizon,
    );

    // Load existing decisions for these events
    const eventIds = allEvents.map((e: any) => e.id);
    const existingMap = new Map<string, any[]>();
    if (eventIds.length > 0) {
      const { data: decisions } = await supabase
        .from("programming_decisions")
        .select("event_id, checkpoint_index, decision, evaluated_at, signup_count")
        .eq("club_id", clubId)
        .in("event_id", eventIds);
      for (const d of decisions ?? []) {
        const eid = (d as any).event_id;
        if (!existingMap.has(eid)) existingMap.set(eid, []);
        existingMap.get(eid)!.push(d);
      }
    }

    // Build risk rows — only include events matched by at least one rule
    const riskRows: any[] = [];

    for (const event of allEvents) {
      const startTime    = new Date(event.startTime);
      const hoursUntil   = (startTime.getTime() - now.getTime()) / 3_600_000;

      const classResult  = classifyEvent(
        { name: event.name ?? "", podplayType: event.customType ?? "", tags: event.tags ?? [], startTime: event.startTime },
        archetypes,
      );
      const archetypeId  = classResult.isExcluded ? null : (classResult.archetypeId ?? null);
      const archetypeName = archetypes.find((a) => a.id === archetypeId)?.canonical_name ?? null;

      for (const rule of rules) {
        const mr = rule.match_rules as any;
        let matches = true;
        if (mr.archetype_ids?.length && (!archetypeId || !mr.archetype_ids.includes(archetypeId))) matches = false;
        if (matches && mr.keywords?.length) {
          const name = (event.name ?? "").toLowerCase();
          if (!mr.keywords.some((kw: string) => name.includes(kw.toLowerCase()))) matches = false;
        }
        if (matches && mr.podplay_types?.length && !mr.podplay_types.includes(event.customType)) matches = false;
        if (!matches) continue;

        const cps: any[] = rule.checkpoints as any[];
        // All checkpoints sorted by offset_hours ascending (nearest first for display)
        const sortedCps = [...cps].sort((a, b) => a.offset_hours - b.offset_hours);

        for (const cp of sortedCps) {
          const hoursUntilTrigger = hoursUntil - cp.offset_hours;
          const existingDecision  = existingMap.get(event.id)?.find((d: any) => d.checkpoint_index === cp.index);

          riskRows.push({
            event_id:            event.id,
            event_name:          event.name,
            event_start_time:    event.startTime,
            archetype_id:        archetypeId,
            archetype_name:      archetypeName,
            total_teams:         event.totalTeams ?? null,
            hours_until_start:   Math.round(hoursUntil * 10) / 10,
            rule_id:             rule.id,
            rule_name:           rule.name,
            checkpoint_index:    cp.index,
            checkpoint_offset_hours: cp.offset_hours,
            checkpoint_min_signups:  cp.min_signups,
            checkpoint_action:   cp.action,
            hours_until_trigger: Math.round(hoursUntilTrigger * 10) / 10,
            trigger_fired:       hoursUntilTrigger <= 0,
            // Current signup count unknown without an extra API call here;
            // show from existing decision if we have one
            last_signup_count:   existingDecision?.signup_count ?? null,
            last_decision:       existingDecision?.decision ?? null,
            last_evaluated_at:   existingDecision?.evaluated_at ?? null,
            // Native PodPlay config
            native_threshold:    event.lowTurnoutAutoCancelAttendeeCount ?? null,
            native_hours_before: event.lowTurnoutAutoCancelHoursBefore ?? null,
          });
        }
      }
    }

    // Sort by hours_until_trigger ascending (most urgent first)
    riskRows.sort((a, b) => a.hours_until_trigger - b.hours_until_trigger);

    res.json({ count: riskRows.length, evaluated_at: now.toISOString(), rows: riskRows });
  } catch (err: any) {
    logger.error({ err }, "[programming/upcoming-risk] error");
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/programming/backfill-fill ───────────────────────────────────────
//
// Re-compute event_fill.final_signups / fill_rate for all existing rows using
// active signup counts from PodPlay (excludes CANCELED/DRAFT; INVALID kept for series clinics).
// Body: { clubId: string, dryRun?: boolean }

const BackfillBodySchema = z.object({
  clubId: z.string().uuid(),
  dryRun: z.boolean().optional(),
});

router.post("/programming/backfill-fill", async (req, res) => {
  const parsed = BackfillBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "clubId (uuid) required; dryRun optional boolean" }); return;
  }
  const { clubId, dryRun = false } = parsed.data;
  const j = jobs[JOB_FILL_BACKFILL];

  if (j.status === "running") {
    res.status(409).json({
      error: "Backfill already running",
      startedAt: j.startedAt,
    });
    return;
  }

  j.status = "running";
  j.startedAt = new Date().toISOString();
  j.finishedAt = null;
  j.stats = null;
  j.error = null;
  j.logs.length = 0;

  res.status(202).json({
    status: "started",
    dryRun,
    clubId,
    message: "Fill backfill running. Poll GET /api/programming/backfill-fill/status.",
    startedAt: j.startedAt,
  });

  (async () => {
    const log = (msg: string) => appendLog(JOB_FILL_BACKFILL, msg);
    let processed = 0, changed = 0, errors = 0, skipped = 0;

    try {
      // Load club API config
      const { data: club } = await supabase
        .from("clubs")
        .select("platform_api_key, platform_subdomain")
        .eq("id", clubId)
        .maybeSingle();
      if (!club?.platform_subdomain) throw new Error("Club not found");
      const apiKey  = club.platform_api_key ?? process.env.PODPLAY_API_KEY ?? "";
      const apiBase = `https://${club.platform_subdomain}.podplay.app/apis/v2`;

      log(`[backfill-fill] dryRun=${dryRun}`);

      // Load all non-canceled event_fill rows for this club
      let rows: any[] = [];
      let page = 0;
      while (true) {
        const { data, error } = await supabase
          .from("event_fill")
          .select("event_id, total_teams, final_signups, fill_rate, is_canceled")
          .eq("club_id", clubId)
          .eq("is_canceled", false)
          .not("total_teams", "is", null)
          .gt("total_teams", 0)
          .range(page * 500, (page + 1) * 500 - 1);
        if (error) throw new Error(`load event_fill: ${error.message}`);
        if (!data?.length) break;
        rows.push(...data);
        if (data.length < 500) break;
        page++;
      }
      log(`[backfill-fill] ${rows.length} rows to process`);

      for (const row of rows) {
        processed++;
        if (processed % 50 === 0) {
          log(`[backfill-fill] ${processed}/${rows.length} changed=${changed} errors=${errors}`);
        }

        let activeCount: number;
        try {
          activeCount = await fetchActiveSignupCount(apiBase, apiKey, row.event_id);
          await new Promise((r) => setTimeout(r, 200));
        } catch (err: any) {
          errors++;
          logger.warn({ eventId: row.event_id, err: err.message }, "[backfill-fill] signup fetch failed");
          continue;
        }

        if (activeCount === row.final_signups) {
          skipped++;
          continue;
        }

        const newFillRate = Math.round((activeCount / row.total_teams) * 10000) / 10000;

        if (!dryRun) {
          const { error: updateErr } = await supabase
            .from("event_fill")
            .update({ final_signups: activeCount, fill_rate: newFillRate })
            .eq("event_id", row.event_id);
          if (updateErr) {
            errors++;
            logger.warn({ eventId: row.event_id, updateErr }, "[backfill-fill] update failed");
            continue;
          }
        }
        changed++;
      }

      const summary = { processed, changed, unchanged: skipped, errors };
      j.status = "done";
      j.stats = summary;
      log(`[backfill-fill] done — ${JSON.stringify(summary)}`);
    } catch (err: any) {
      j.status = "error";
      j.error = err.message;
      logger.error({ err }, "[backfill-fill] failed");
    } finally {
      j.finishedAt = new Date().toISOString();
    }
  })();
});

router.get("/programming/backfill-fill/status", (_req, res) => {
  const j = jobs[JOB_FILL_BACKFILL];
  res.json({
    status: j.status,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    stats: j.stats,
    error: j.error,
    recentLogs: j.logs.slice(-20),
  });
});

// ── POST /api/programming/backtest ────────────────────────────────────────────
//
// Replay a candidate rule spec against historical event_fill rows, using
// attendances.booked_at to RECONSTRUCT the signup count at the checkpoint
// offset rather than the final count (which inverts the signal: every event
// looks fully enrolled by the end, so nothing fires and FP rate → 0).
//
// Exclusions applied:
//   1. booked_at coverage < 90% for that event (not enough timestamp data).
//   2. Archetype whose median local-attendance / PodPlay-signups ratio < 0.70
//      → local attendance systematically undercounts PodPlay for this type
//      (identified as series-pass clinics; reported separately).
//
// All three match_rules filter types are supported when migration 005 has
// been applied (adds event_name + podplay_type columns to event_fill).
// Pre-migration: keywords and podplay_types filters are skipped with a
// migration_required_note in the response; archetype_ids still applied.
//
// Body: {
//   clubId: string,
//   rule: {
//     match_rules: { archetype_ids?, keywords?, podplay_types? },
//     checkpoints: [{ index, offset_hours, min_signups, action }]
//   },
//   days?:               number   (default 120, max 365)
//   includeEventDetails?: bool    (default true; set false for sweep iterations)
// }

const BacktestBodySchema = z.object({
  clubId:              z.string().uuid(),
  days:                z.number().int().min(7).max(365).optional(),
  includeEventDetails: z.boolean().optional(),
  rule: z.object({
    match_rules: z.object({
      archetype_ids: z.array(z.string()).optional(),
      keywords:      z.array(z.string()).optional(),
      podplay_types: z.array(z.string()).optional(),
    }),
    checkpoints: z.array(z.object({
      index:                z.number().int(),
      offset_hours:         z.number().int(),
      min_signups:          z.number().int(),
      action:               z.enum(["CANCEL", "ALERT", "PROMOTE"]),
      fill_ratio_threshold: z.number().min(0).max(1).optional(), // e.g. 0.40 = 40% of total_teams
    })).min(1),
  }),
});

router.post("/programming/backtest", async (req, res) => {
  const parsed = BacktestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues }); return;
  }
  const { clubId, days = 120, rule, includeEventDetails = true } = parsed.data;

  try {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const nowIso = new Date().toISOString();

    // ── 1. Load event_fill rows in window ──────────────────────────────────────
    //
    // Try to SELECT event_name + podplay_type (added in migration 005).
    // Fall back to the pre-migration column set if those columns don't exist yet.
    let fillRows: any[] = [];
    let metadataColumnsAvailable = true;

    const runFillQuery = async (includeMetadata: boolean) => {
      const cols = includeMetadata
        ? "event_id, archetype_id, final_signups, total_teams, fill_rate, start_time, event_name, podplay_type"
        : "event_id, archetype_id, final_signups, total_teams, fill_rate, start_time";
      let page = 0;
      const rows: any[] = [];
      while (true) {
        const { data, error } = await supabase
          .from("event_fill")
          .select(cols)
          .eq("club_id", clubId)
          .eq("is_canceled", false)
          .not("archetype_id", "is", null)
          .gte("start_time", cutoff)
          .lt("start_time",  nowIso)
          .range(page * 500, (page + 1) * 500 - 1);
        if (error) throw error;
        if (!data?.length) break;
        rows.push(...data);
        if (data.length < 500) break;
        page++;
      }
      return rows;
    };

    try {
      fillRows = await runFillQuery(true);
    } catch (err: any) {
      if (err?.message?.includes("does not exist")) {
        // Migration 005 not yet applied — columns not available
        metadataColumnsAvailable = false;
        try {
          fillRows = await runFillQuery(false);
        } catch (err2: any) {
          res.status(500).json({ error: err2.message }); return;
        }
      } else {
        res.status(500).json({ error: err.message }); return;
      }
    }

    // ── 2. Load archetype names ────────────────────────────────────────────────
    const { data: archetypesData } = await supabase
      .from("programs")
      .select("id, canonical_name")
      .eq("club_id", clubId);
    const archetypeNames = new Map<string, string>(
      (archetypesData ?? []).map((a: any) => [a.id, a.canonical_name]),
    );

    if (fillRows.length === 0) {
      res.json({ days, total_events_in_window: 0, archetype_coverage: {}, checkpoints: [] });
      return;
    }

    // ── 3. Load attendances (booked_at + program_name) in chunks of 200 ───────
    //
    // Supabase REST handles up to ~200 IDs in an IN clause reliably.
    // We paginate attendance rows within each chunk.
    type AttData = {
      total: number;
      withBookedAt: number;
      times: number[];       // epoch-ms for each non-null booked_at
      programName: string | null;
    };
    const attMap = new Map<string, AttData>();

    const allEventIds = [...new Set(fillRows.map((r: any) => r.event_id as string))];
    const ID_CHUNK    = 200;
    const ATT_PAGE    = 1000;

    for (let ci = 0; ci < allEventIds.length; ci += ID_CHUNK) {
      const chunk = allEventIds.slice(ci, ci + ID_CHUNK);
      let ap = 0;
      while (true) {
        const { data: batch, error: bErr } = await supabase
          .from("attendances")
          .select("event_id, booked_at, program_name")
          .in("event_id", chunk)
          .range(ap * ATT_PAGE, (ap + 1) * ATT_PAGE - 1);
        if (bErr || !batch?.length) break;
        for (const row of batch) {
          const eid = (row as any).event_id as string;
          if (!attMap.has(eid)) attMap.set(eid, { total: 0, withBookedAt: 0, times: [], programName: null });
          const c = attMap.get(eid)!;
          c.total++;
          if ((row as any).booked_at) {
            c.withBookedAt++;
            c.times.push(new Date((row as any).booked_at as string).getTime());
          }
          if (!c.programName && (row as any).program_name) c.programName = (row as any).program_name;
        }
        if (batch.length < ATT_PAGE) break;
        ap++;
      }
    }

    // ── 4. Per-archetype undercount detection ──────────────────────────────────
    //
    // Compares local attendance row count to event_fill.final_signups (the
    // PodPlay active count). A ratio consistently below 0.70 signals that local
    // attendance systematically undercounts PodPlay — observed for series-pass
    // clinics (Path to Intermediate) where INVALID signups are not in the
    // VALID_SIGNUP_STATUSES set used by syncEventAttendance (separate fix
    // needed). Reconstructing from undercounted data understates enrollment and
    // inflates the apparent fire rate, so those archetypes are excluded.

    const archetypeRatioMap = new Map<string, { name: string; ratios: number[] }>();
    for (const fill of fillRows) {
      if (!fill.archetype_id || !fill.final_signups || fill.final_signups <= 0) continue;
      const localCount = attMap.get(fill.event_id)?.total ?? 0;
      const ratio = localCount / (fill.final_signups as number);
      if (!archetypeRatioMap.has(fill.archetype_id)) {
        archetypeRatioMap.set(fill.archetype_id, {
          name: archetypeNames.get(fill.archetype_id) ?? fill.archetype_id.slice(0, 8),
          ratios: [],
        });
      }
      archetypeRatioMap.get(fill.archetype_id)!.ratios.push(ratio);
    }

    const UNDERCOUNT_THRESHOLD = 0.70;
    const archetypeCoverage: Record<string, any> = {};
    const excludedArchetypes  = new Set<string>();

    for (const [aid, { name, ratios }] of archetypeRatioMap) {
      const sorted = [...ratios].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      if (median < UNDERCOUNT_THRESHOLD) excludedArchetypes.add(aid);
      archetypeCoverage[name] = {
        median_local_vs_podplay: Math.round(median * 1000) / 1000,
        n_events: ratios.length,
        excluded: median < UNDERCOUNT_THRESHOLD,
        ...(median < UNDERCOUNT_THRESHOLD
          ? { reason: "local attendance undercounts PodPlay signups — likely series-pass clinic or very low member penetration" }
          : {}),
      };
    }

    // ── 5. Per-checkpoint reconstruction and TP/FP classification ─────────────
    //
    // Ground truth (Phase 2.4):
    //   - Already-cancelled events are EXCLUDED from scoring. Their final_signups
    //     is truncated by the cancellation itself, so they cannot be scored as TP
    //     or FP — that would assume the cancellation was correct, which is exactly
    //     what the backtest is trying to determine.
    //   - False positive: would-fire AND final_signups >= min_signups
    //     (the rule would have cancelled a session that reached threshold)
    //   - True positive:  would-fire AND final_signups <  min_signups
    //     (the rule correctly identified a session that stayed under threshold)
    //
    // Replaces Phase 2.3 proxy (fill_rate < 0.5) which was an arbitrary second
    // threshold applied on top of the first, not a real cancellation outcome.

    const checkpointResults: any[] = [];

    for (const cp of rule.checkpoints) {
      let evaluated = 0, wouldFire = 0, tp = 0, fp = 0, fn = 0, tn = 0;
      let skippedCoverage = 0, skippedUndercount = 0, skippedNoData = 0;
      let skippedAlreadyCancelled = 0;
      const byArchetype:   Record<string, { evaluated: number; wouldFire: number; tp: number; fp: number; fn: number; tn: number }> = {};
      const byProgramType: Record<string, { evaluated: number; wouldFire: number; tp: number; fp: number; fn: number; tn: number }> = {};
      // Item 2c — capacity bands: small (≤6 teams), medium (7–12), large (13+)
      const byCapacity:    Record<string, { evaluated: number; wouldFire: number; tp: number; fp: number; fn: number; tn: number }> = {};
      const eventDetails: any[] = [];
      const usableRowCounts: number[] = [];

      for (const fill of fillRows) {
        // Match against all three filter types.
        // event_name and podplay_type require migration 005; when unavailable
        // (metadataColumnsAvailable=false) those filters are skipped and a
        // migration_required_note is included in the response.
        const mr = rule.match_rules;
        if (mr.archetype_ids?.length && !mr.archetype_ids.includes(fill.archetype_id)) continue;
        if (metadataColumnsAvailable && mr.keywords?.length) {
          const name = ((fill.event_name as string | null) ?? "").toLowerCase();
          if (!mr.keywords.some((kw: string) => name.includes(kw.toLowerCase()))) continue;
        }
        if (metadataColumnsAvailable && mr.podplay_types?.length && !mr.podplay_types.includes(fill.podplay_type as string)) continue;

        const archName = archetypeNames.get(fill.archetype_id) ?? "Unknown";

        // Undercount exclusion
        if (excludedArchetypes.has(fill.archetype_id)) { skippedUndercount++; continue; }

        // booked_at coverage guard
        const att = attMap.get(fill.event_id);
        if (!att || att.total === 0)                          { skippedNoData++;    continue; }
        const coverage = att.withBookedAt / att.total;
        if (coverage < 0.9)                                   { skippedCoverage++; continue; }

        // Reconstruct signup count at checkpoint offset from booked_at timestamps.
        // These are MEMBER-TRACKED bookings only; non-members are not in attendances.
        // For archetypes where membership penetration ≈ 100% this is exact;
        // for mixed-membership open play it is a lower bound.
        const startMs  = new Date(fill.start_time as string).getTime();
        const cutoffMs = startMs - cp.offset_hours * 3_600_000;
        const signupAtOffset = att.times.filter((t) => t <= cutoffMs).length;
        const totalTeams = (fill.total_teams as number | null) ?? null;

        // Fire condition — supports both absolute count and fill-ratio triggers.
        // fill_ratio_threshold: fraction of total_teams (e.g. 0.40 = 40% fill).
        // Falls back to min_signups when ratio is not set or total_teams unknown.
        const isRatioTrigger = cp.fill_ratio_threshold !== undefined &&
          cp.fill_ratio_threshold !== null && totalTeams !== null;
        const fires = isRatioTrigger
          ? (signupAtOffset / totalTeams!) < cp.fill_ratio_threshold!
          : signupAtOffset < cp.min_signups;

        // Ground truth: did the session end under-enrolled?
        // For CANCEL checkpoints: under-enrolled = final < threshold (cancellation warranted).
        // For PROMOTE checkpoints: same — under-enrolled = final < threshold (outreach warranted).
        //   TP = fired AND ended under-enrolled  (correctly triggered)
        //   FP = fired AND session filled anyway  (wasted send, not harmful)
        //   FN = did not fire AND ended under-enrolled  (missed opportunity)
        //   TN = did not fire AND session filled  (correctly left alone)
        // FN = 0 is only mathematically guaranteed for CANCEL under the booked_at
        // reconstruction (count_at_offset ≤ final_signups). For PROMOTE this is NOT
        // guaranteed: a session with enough signups at T-6h can still end under-enrolled.
        if (fill.final_signups === null || fill.final_signups === undefined) {
          skippedAlreadyCancelled++;
          continue;
        }

        usableRowCounts.push(att.total);

        const finalCount = fill.final_signups as number;
        const groundTruthUnderenrolled = isRatioTrigger && totalTeams !== null
          ? finalCount / totalTeams < cp.fill_ratio_threshold!
          : finalCount < cp.min_signups;

        const truePositive  =  fires &&  groundTruthUnderenrolled;
        const falsePositive =  fires && !groundTruthUnderenrolled;
        const falseNegative = !fires &&  groundTruthUnderenrolled;
        const trueNegative  = !fires && !groundTruthUnderenrolled;

        if (!byArchetype[archName]) byArchetype[archName] = { evaluated: 0, wouldFire: 0, tp: 0, fp: 0, fn: 0, tn: 0 };
        const ab = byArchetype[archName];

        // Program-type segmentation (Clinics vs Open Play)
        const lc = archName.toLowerCase();
        const progType = (lc.includes("clinic") || lc.includes("learn") || lc.includes("junior"))
          ? "Clinics"
          : "Open Play";
        if (!byProgramType[progType]) byProgramType[progType] = { evaluated: 0, wouldFire: 0, tp: 0, fp: 0, fn: 0, tn: 0 };
        const pt = byProgramType[progType];

        // Item 2c — capacity bands (total_teams from event_fill, requires migration 006)
        const capBand = !totalTeams ? "unknown"
          : totalTeams <= 6  ? "small (≤6)"
          : totalTeams <= 12 ? "medium (7–12)"
          :                    "large (13+)";
        if (!byCapacity[capBand]) byCapacity[capBand] = { evaluated: 0, wouldFire: 0, tp: 0, fp: 0, fn: 0, tn: 0 };
        const cb = byCapacity[capBand];

        evaluated++; ab.evaluated++; pt.evaluated++; cb.evaluated++;
        if (fires) {
          wouldFire++; ab.wouldFire++; pt.wouldFire++; cb.wouldFire++;
          if (truePositive)  { tp++; ab.tp++; pt.tp++; cb.tp++; }
          if (falsePositive) { fp++; ab.fp++; pt.fp++; cb.fp++; }
        } else {
          if (falseNegative) { fn++; ab.fn++; pt.fn++; cb.fn++; }
          if (trueNegative)  { tn++; ab.tn++; pt.tn++; cb.tn++; }
        }

        if (includeEventDetails) {
          eventDetails.push({
            event_id:             fill.event_id,
            program_name:         att.programName ?? archName,
            date:                 (fill.start_time as string)?.slice(0, 10) ?? null,
            archetype:            archName,
            program_type:         progType,
            capacity_band:        capBand,
            total_teams:          totalTeams,
            count_at_offset:      signupAtOffset,
            final_signups:        finalCount,
            fill_ratio_at_offset: totalTeams ? Math.round((signupAtOffset / totalTeams) * 1000) / 1000 : null,
            fill_ratio_final:     totalTeams ? Math.round((finalCount      / totalTeams) * 1000) / 1000 : null,
            booked_at_coverage:   Math.round(coverage * 1000) / 1000,
            would_fire:           fires,
            is_tp:                truePositive,
            is_fp:                falsePositive,
            is_fn:                falseNegative,
            is_tn:                trueNegative,
          });
        }
      }

      // Quantization uncertainty: a 1-signup swing at median n rows/event
      const sortedUR    = [...usableRowCounts].sort((a, b) => a - b);
      const medUR       = sortedUR.length ? sortedUR[Math.floor(sortedUR.length / 2)] : null;
      const uncertainty = medUR !== null && medUR > 0
        ? `±${Math.round(100 / medUR)}pp (1-signup at median ${medUR} rows/event)`
        : "unknown";

      // Compute aggregate rates
      const fireRate  = evaluated > 0 ? wouldFire / evaluated : null;
      const fpRate    = wouldFire  > 0 ? fp / wouldFire        : null;
      const precision = wouldFire  > 0 ? tp / wouldFire        : null;
      const recall    = (tp + fn)  > 0 ? tp / (tp + fn)        : null;

      // Degenerate-cell flags (1c)
      const flags: string[] = [];
      if (wouldFire < 10)                        flags.push("LOW_SAMPLE: fired<10, results unreliable");
      if (fireRate !== null && fireRate > 0.5)   flags.push("EXCESS_FIRE: cancels >50% of schedule");

      const r = (v: number | null) => v !== null ? Math.round(v * 1000) / 1000 : null;

      checkpointResults.push({
        checkpoint_index:     cp.index,
        offset_hours:         cp.offset_hours,
        min_signups:          cp.min_signups,
        action:               cp.action,
        evaluated,
        fired:                wouldFire,    // alias for clarity (spec term)
        true_positives:       tp,
        false_positives:      fp,
        false_negatives:      fn,
        true_negatives:       tn,
        skipped_low_coverage: skippedCoverage,
        skipped_undercount:   skippedUndercount,
        skipped_no_data:      skippedNoData,
        skipped_already_cancelled: skippedAlreadyCancelled,
        fire_rate:  r(fireRate),
        fp_rate:    r(fpRate),
        precision:  r(precision),
        recall:     r(recall),
        flags:      flags.length ? flags : undefined,
        median_usable_rows: medUR,
        uncertainty_band:   uncertainty,
        reconstruction_caveat:
          fn === 0 && cp.action !== "PROMOTE"
            ? "FN=0 is a mathematical property of booked_at reconstruction for CANCEL checkpoints: " +
              "count_at_offset ≤ final_signups by construction (timestamps are monotonically non-decreasing). " +
              "Recall=1.0 does not imply the rule catches all dead sessions in reality. " +
              "For PROMOTE checkpoints, FN > 0 is possible: a session with enough signups at the offset " +
              "can still end under-enrolled — the reconstruction does not guarantee FN=0 there."
            : fn === 0 && cp.action === "PROMOTE"
              ? "FN=0 for this PROMOTE checkpoint — sessions with signupAtOffset >= threshold all ended above threshold too. " +
                "Plausible at generous thresholds; verify against a tighter one."
              : undefined,
        by_archetype: Object.fromEntries(
          Object.entries(byArchetype).map(([name, s]) => [name, {
            evaluated:       s.evaluated,
            fired:           s.wouldFire,
            tp:              s.tp,
            fp:              s.fp,
            fn:              s.fn,
            tn:              s.tn,
            fire_rate:  r(s.evaluated > 0 ? s.wouldFire / s.evaluated : null),
            fp_rate:    r(s.wouldFire  > 0 ? s.fp / s.wouldFire        : null),
            precision:  r(s.wouldFire  > 0 ? s.tp / s.wouldFire        : null),
            recall:     r((s.tp + s.fn) > 0 ? s.tp / (s.tp + s.fn)    : null),
          }]),
        ),
        by_program_type: Object.entries(byProgramType).map(([label, s]) => ({
          program_type: label,
          evaluated:    s.evaluated,
          fired:        s.wouldFire,
          tp:           s.tp,
          fp:           s.fp,
          fn:           s.fn,
          tn:           s.tn,
          fire_rate:  r(s.evaluated > 0 ? s.wouldFire / s.evaluated : null),
          fp_rate:    r(s.wouldFire  > 0 ? s.fp / s.wouldFire        : null),
          precision:  r(s.wouldFire  > 0 ? s.tp / s.wouldFire        : null),
          recall:     r((s.tp + s.fn) > 0 ? s.tp / (s.tp + s.fn)    : null),
        })),
        // Item 2c — capacity segmentation (small ≤6, medium 7–12, large 13+)
        by_capacity: Object.entries(byCapacity).map(([band, s]) => ({
          capacity_band: band,
          evaluated:     s.evaluated,
          fired:         s.wouldFire,
          tp:            s.tp,
          fp:            s.fp,
          fn:            s.fn,
          tn:            s.tn,
          fire_rate:  r(s.evaluated > 0 ? s.wouldFire / s.evaluated : null),
          fp_rate:    r(s.wouldFire  > 0 ? s.fp / s.wouldFire        : null),
          precision:  r(s.wouldFire  > 0 ? s.tp / s.wouldFire        : null),
          recall:     r((s.tp + s.fn) > 0 ? s.tp / (s.tp + s.fn)    : null),
        })),
        ...(cp.fill_ratio_threshold !== undefined ? { fill_ratio_threshold: cp.fill_ratio_threshold } : {}),
        ...(includeEventDetails ? { event_details: eventDetails } : {}),
      });
    }

    // ── 6. Validation hint ────────────────────────────────────────────────────
    // The Phase 0.6 figure at N=4/T-3h on clean data was ~44% FP rate.
    // A near-zero result on adequate sample means reconstruction is still broken.
    const mirrorCp = checkpointResults.find((r) => r.offset_hours === 3 && r.min_signups === 4);
    const validationWarning =
      mirrorCp && mirrorCp.fp_rate !== null && mirrorCp.fp_rate < 0.05 && mirrorCp.evaluated > 5
        ? "WARNING: FP rate near zero for N=4/T-3h — reconstruction may still be broken. Expected ~44% from Phase 0.6."
        : null;

    res.json({
      days,
      total_events_in_window: fillRows.length,
      archetype_coverage:     archetypeCoverage,
      outcome_definition:
        "For CANCEL checkpoints — TP: fired AND session stayed under-enrolled (correct cancellation); " +
        "FP: fired AND session filled anyway (would have cancelled a fine session); " +
        "FN: did not fire AND session stayed under-enrolled (missed a dead session); " +
        "TN: did not fire AND session filled (correctly left alone). " +
        "For PROMOTE checkpoints — framing inverts: TP = outreach warranted AND triggered correctly; " +
        "FP = wasted send (session filled on its own); FN = missed under-enrolled session; TN = correctly left alone. " +
        "A high FP rate for PROMOTE means sessions that triggered outreach filled anyway — not harmful, but wasteful. " +
        "Already-cancelled events excluded (truncated final count cannot score either way).",
      reconstruction_note:
        "signup_count_at_offset reconstructed from attendances.booked_at (member-tracked subset only). " +
        "Archetypes with median local/PodPlay ratio < 0.70 are excluded from checkpoint results.",
      ...(!metadataColumnsAvailable ? {
        migration_required_note:
          "Migration 005 (event_fill: event_name, podplay_type) has not been applied. " +
          "keywords and podplay_types filters were skipped — only archetype_ids matching applied. " +
          "Run artifacts/api-server/migrations/005_event_fill_columns.sql in the Supabase SQL editor, " +
          "then run the backfill script (src/scripts/backfillEventFillMetadata.ts).",
      } : {}),
      ...(validationWarning ? { validation_warning: validationWarning } : {}),
      checkpoints: checkpointResults,
    });

  } catch (err: any) {
    logger.error({ err }, "[programming/backtest] error");
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/programming/batch-timing ───────────────────────────────────────
//
// Compute attendance_archetype / avg_booking_lead_days / preferred_booking_dow
// for every player in the club whose timing is stale or missing.
//
// Query params:
//   dryRun=true   — simulate and return distribution; write nothing (default: false)
//   forceRefresh  — bypass 22-hour cache guard (default: false)
//
// Also invoked nightly from the scheduler (Step 9).

router.post("/programming/batch-timing", requireClub, async (req, res) => {
  const clubId   = (req as ClubScopedRequest).clubId;
  const dryRun   = req.query.dryRun !== "false";          // default: dry-run
  const force    = req.query.forceRefresh === "true";

  try {
    const result = await batchComputePlayerTiming(clubId, { dryRun, forceRefresh: force });
    res.json({ dry_run: dryRun, ...result });
  } catch (err: any) {
    logger.error({ err }, "[programming/batch-timing] error");
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/programming/rules ────────────────────────────────────────────────

router.get("/programming/rules", async (req, res) => {
  const clubId = req.query.clubId as string;
  if (!clubId) { res.status(400).json({ error: "clubId required" }); return; }
  const { data, error } = await supabase
    .from("programming_rules")
    .select("*")
    .eq("club_id", clubId)
    .order("created_at", { ascending: true });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ rules: data ?? [] });
});

// ── POST /api/programming/rules/seed-phase3 ───────────────────────────────────
//
// Idempotent — safe to re-run. Disables the old mirror rule and upserts the
// two Phase 3 rules (Open Play N=4/T-2h and Clinics N=2/T-2h + N=4/T-18h).
// Returns a count of upcoming events matching each rule's podplay_type.

router.post("/programming/rules/seed-phase3", async (req, res) => {
  const clubId = ((req.body as any)?.clubId ?? req.query.clubId) as string;
  if (!clubId) { res.status(400).json({ error: "clubId required" }); return; }

  try {
    // 1. Disable the legacy mirror rule
    await supabase
      .from("programming_rules")
      .update({ enabled: false })
      .eq("club_id", clubId)
      .eq("name", "Off-Peak Open Play — native mirror");

    // 2. Rule definitions (retention framing — revised spec)
    //
    // Open play: PROMOTE added at T-6h (initial threshold N=6; backtest at T-6h across
    // N=4–10 recommended before tuning — fill ratio may be a better trigger than absolute
    // count for sessions with 6–18 capacity, but requires a schema extension).
    // Clinics: PROMOTE at T-18h (unchanged — strong backtest results at N=4).
    const ruleDefs = [
      {
        club_id:     clubId,
        name:        "Open Play — cancel + promote",
        enabled:     true,
        mode:        "shadow" as const,
        match_rules: { podplay_types: ["Open Play"] },
        checkpoints: [
          { index: 0, offset_hours: 6, min_signups: 6, action: "PROMOTE" }, // T-6h promote (initial; needs backtest)
          { index: 1, offset_hours: 2, min_signups: 4, action: "CANCEL"  }, // T-2h cancel
        ],
      },
      {
        club_id:     clubId,
        name:        "Clinics — cancel + promote",
        enabled:     true,
        mode:        "shadow" as const,
        match_rules: { podplay_types: ["Clinics"] },
        checkpoints: [
          { index: 0, offset_hours: 18, min_signups: 4, action: "PROMOTE" }, // T-18h promote
          { index: 1, offset_hours: 2,  min_signups: 2, action: "CANCEL"  }, // T-2h cancel
        ],
      },
    ];

    // Disable old "Open Play — cancel" rule (renamed to "Open Play — cancel + promote").
    // Idempotent — if it doesn't exist, the update is a no-op.
    await supabase
      .from("programming_rules")
      .update({ enabled: false })
      .eq("club_id", clubId)
      .eq("name", "Open Play — cancel");

    const results: any[] = [];
    for (const def of ruleDefs) {
      const { data: existing } = await supabase
        .from("programming_rules")
        .select("id")
        .eq("club_id", clubId)
        .eq("name", def.name)
        .maybeSingle();

      if (existing) {
        const { data: updated } = await supabase
          .from("programming_rules")
          .update({ enabled: def.enabled, match_rules: def.match_rules, checkpoints: def.checkpoints, mode: def.mode })
          .eq("id", (existing as any).id)
          .select("id, name, enabled, match_rules, checkpoints")
          .single();
        results.push({ action: "updated", rule: updated });
      } else {
        const { data: inserted } = await supabase
          .from("programming_rules")
          .insert(def)
          .select("id, name, enabled, match_rules, checkpoints")
          .single();
        results.push({ action: "inserted", rule: inserted });
      }
    }

    // 3. Count upcoming events in the next 96 h by podplay_type
    //    event_fill.podplay_type requires migration 006; fall back gracefully.
    const now     = new Date().toISOString();
    const horizon = new Date(Date.now() + 96 * 3_600_000).toISOString();
    let upcomingCounts: Record<string, number> = {};
    let upcomingNote = "";

    try {
      const { data: upcomingRows } = await supabase
        .from("event_fill")
        .select("podplay_type")
        .eq("club_id", clubId)
        .eq("is_canceled", false)
        .gte("start_time", now)
        .lte("start_time", horizon);

      if (upcomingRows) {
        for (const row of upcomingRows) {
          const t = (row as any).podplay_type ?? "(null)";
          upcomingCounts[t] = (upcomingCounts[t] ?? 0) + 1;
        }
        upcomingNote = "event_fill.podplay_type populated — counts are exact";
      }
    } catch {
      upcomingNote = "event_fill.podplay_type not yet available (run migration 006 + backfillEventFillMetadata.ts). Cannot count by type; check /api/programming/upcoming-risk for live matching.";
    }

    res.json({
      seeded: results,
      upcoming_events_next_96h_by_type: upcomingCounts,
      upcoming_note: upcomingNote,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/programming/promotion-candidates/:decisionId ─────────────────────
//
// Build (and store) the ranked retention audience for a PROMOTE decision.
// DATA ONLY — nothing here sends a message or writes to messages/notifications.
//
// Query params:
//   rebuild=true  — re-score and overwrite existing promotion_candidates rows
//                   (default: false — return existing rows if present)
//
// Revised model (retention-first spec):
//   Hard gates (remove from consideration entirely):
//     1. Already booked for this event
//     2. Level mismatch (where real level data exists; ~9% of players)
//     3. Contact budget — cooldown and rolling cap from the ledger
//     4. Long-dormant (91+ days) — routed to a separate win-back motion
//
//   Soft ranking signals (affect score only, never gate):
//     - Retention segment: lapsing (15–30d) > recent-dormant (31–90d) > active (≤14d)
//     - Warm score — program-specific, computed at build time
//     - Archetype — small bonus at appropriate lead times (early/planner at T-18h+,
//       late at T-6h-); 'default' (2,117 players) is explicitly neutral (no penalty)
//     - Slot fit — preferred DOW / hour vs. event
//     - Buddy signal — buddy already registered (strongest single signal when present)
//     - Contact rotation — recency of last promotional contact

const LEVEL_NUMERIC: Record<string, number> = {
  "Beginner":             1.5,
  "Advanced Beginner":    2.5,
  "Low Intermediate":     3.0,
  "Intermediate":         3.5,
  "Advanced Intermediate":3.75,
  "Advanced":             4.5,
};

router.get("/programming/promotion-candidates/:decisionId", async (req, res) => {
  const { decisionId } = req.params;
  const rebuild = req.query.rebuild === "true";

  try {
    // ── 0. Load decision ──────────────────────────────────────────────────────
    const { data: dec, error: decErr } = await supabase
      .from("programming_decisions")
      .select("*")
      .eq("id", decisionId)
      .maybeSingle();

    if (decErr) { res.status(500).json({ error: decErr.message }); return; }
    if (!dec)   { res.status(404).json({ error: "Decision not found" }); return; }
    if ((dec as any).decision !== "PROMOTE") {
      res.status(400).json({ error: `Decision is '${(dec as any).decision}', not PROMOTE` }); return;
    }

    // If not rebuilding, return existing rows
    if (!rebuild) {
      const { data: existing } = await supabase
        .from("promotion_candidates")
        .select("*")
        .eq("decision_id", decisionId)
        .order("rank");
      if (existing && existing.length > 0) {
        res.json({ cached: true, count: existing.length, candidates: existing }); return;
      }
    }

    const clubId  = (dec as any).club_id as string;
    const eventId = (dec as any).event_id as string;

    // ── 1. Fetch club API config ──────────────────────────────────────────────
    const { data: club } = await supabase
      .from("clubs")
      .select("platform_api_key, platform_subdomain")
      .eq("id", clubId)
      .maybeSingle();
    if (!club?.platform_subdomain) {
      res.status(500).json({ error: "Club not configured" }); return;
    }
    const apiBase = `https://${club.platform_subdomain}.podplay.app/apis/v2`;
    const apiKey  = club.platform_api_key ?? process.env.PODPLAY_API_KEY ?? "";

    // ── 2. Fetch event detail (admissionRating, capacity) from PodPlay ────────
    let eventDetail: any = null;
    try {
      const er = await fetch(`${apiBase}/events/${eventId}`, { headers: { "x-api-key": apiKey } });
      if (er.ok) eventDetail = await er.json();
    } catch { /* best-effort */ }

    const eventStartIso  = (dec as any).event_start_time as string;
    const eventStartDate = new Date(eventStartIso);
    const eventDow       = eventStartDate.getUTCDay(); // 0=Sun … 6=Sat (UTC ok for DOW match)
    const eventHour      = eventStartDate.getUTCHours();
    const admissionMin   = eventDetail?.admissionRating?.minRating ?? null;
    const admissionMax   = eventDetail?.admissionRating?.maxRating ?? null;
    const capacity             = (dec as any).total_teams as number ?? 0;
    const checkpointOffsetHours = (dec as any).checkpoint_offset_hours as number ?? 18;

    // ── 2b. Fetch programType from event_fill for warm score computation ───────
    // event_fill.podplay_type is available after migration 006 + backfill.
    // Fall back to rule_name pattern if the column is null — this covers the
    // pre-migration state and avoids misclassifying attendance history.
    const { data: fillRow } = await supabase
      .from("event_fill")
      .select("podplay_type")
      .eq("event_id", eventId)
      .maybeSingle();
    const ruleName = (dec as any).rule_name as string ?? "";
    const programTypeFromRule =
      ruleName.toLowerCase().includes("clinic")     ? "Clinics"   :
      ruleName.toLowerCase().includes("open play")  ? "Open Play" : null;
    const programType = (fillRow?.podplay_type ?? programTypeFromRule ?? null) as string | null;
    const programName = (dec as any).event_name as string ?? "";

    // ── 3. Fetch current signups (to exclude already-booked players) ──────────
    const bookedExternalIds = new Set<string>();
    try {
      let sp = 1;
      while (true) {
        const sr = await fetch(`${apiBase}/events/${eventId}/signups?pageSize=200&page=${sp}`,
          { headers: { "x-api-key": apiKey } });
        if (!sr.ok) break;
        const sb: any = await sr.json();
        const items: any[] = sb?.items ?? [];
        items.forEach((s: any) => { if (s.owner?.id) bookedExternalIds.add(s.owner.id); });
        if (items.length < 200) break;
        sp++;
      }
    } catch { /* best-effort — if we can't fetch signups, we can't exclude */ }

    // ── 4. Load all active players + external_id map ──────────────────────────
    const players: any[] = [];
    let offset = 0;
    while (true) {
      const { data: pg, error: pgErr } = await supabase
        .from("players")
        .select(
          "id, external_id, name, sms_opt_in, opted_out, churn_risk, last_visit_date, " +
          "coach_assigned_level, skill_level, warm_score, attendance_archetype, " +
          "preferred_booking_dow, preferred_booking_hour, last_outbound_at"
        )
        .eq("club_id", clubId)
        .not("external_id", "is", null)
        .range(offset, offset + 999);
      if (pgErr || !pg?.length) break;
      players.push(...pg);
      if (pg.length < 1000) break;
      offset += 1000;
    }

    // ── 5. Convert live PodPlay signups → internal player IDs (buddy signal fix) ─
    // Phase 3.5 fix: previously queried attendances filtered by event_id, which is
    // always empty for upcoming events (attendances only contains past events).
    // bookedExternalIds is already fetched live from PodPlay (step 3) — resolve
    // those external IDs to internal UUIDs via players.external_id so buddy pairs
    // can fire against the real current registrants.
    const signedUpPlayerIds = new Set<string>();
    if (bookedExternalIds.size > 0) {
      const extIdArr = [...bookedExternalIds];
      const EXT_CHUNK = 200;
      for (let ci = 0; ci < extIdArr.length; ci += EXT_CHUNK) {
        const { data: idRows } = await supabase
          .from("players")
          .select("id")
          .eq("club_id", clubId)
          .in("external_id", extIdArr.slice(ci, ci + EXT_CHUNK));
        for (const row of (idRows ?? [])) signedUpPlayerIds.add((row as any).id);
      }
    }

    // ── 6. Load buddy pairs for already-signed-up players ─────────────────────
    const signedUpArr = [...signedUpPlayerIds];
    const buddyMap = new Map<string, string[]>(); // player_id → buddy player_ids
    if (signedUpArr.length > 0) {
      const CHUNK = 100;
      for (let ci = 0; ci < signedUpArr.length; ci += CHUNK) {
        const chunk = signedUpArr.slice(ci, ci + CHUNK);
        const { data: pairs } = await supabase
          .from("buddy_pairs")
          .select("player_a, player_b")
          .or(`player_a.in.(${chunk.join(",")}),player_b.in.(${chunk.join(",")})`);
        for (const pair of (pairs ?? [])) {
          const { player_a, player_b } = pair as any;
          // Buddy is the OTHER player in the pair relative to the signed-up one
          if (signedUpPlayerIds.has(player_a)) {
            if (!buddyMap.has(player_b)) buddyMap.set(player_b, []);
            buddyMap.get(player_b)!.push(player_a);
          }
          if (signedUpPlayerIds.has(player_b)) {
            if (!buddyMap.has(player_a)) buddyMap.set(player_a, []);
            buddyMap.get(player_a)!.push(player_b);
          }
        }
      }
    }

    // ── 6b. Control holdout — exclude active experiment control arm members ────
    // Phase 4: any player in an active experiment's control arm (within 30 days
    // of randomization) must not appear in promotion outreach. This prevents
    // their inclusion in separate sends that would invalidate the experiment.
    // Non-fatal: if the table doesn't exist (pre-migration 007), proceed without.
    const controlHoldoutIds = new Set<string>();
    try {
      const holdoutCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const { data: activeExps } = await supabase
        .from("outreach_experiments")
        .select("id")
        .eq("club_id", clubId)
        .in("status", ["ready", "sent", "measuring"])
        .gte("randomized_at", holdoutCutoff);
      if (activeExps && activeExps.length > 0) {
        const { data: ctrl } = await supabase
          .from("experiment_participants")
          .select("player_id")
          .in("experiment_id", (activeExps as any[]).map(e => e.id))
          .eq("arm", "control")
          .eq("vetoed", false);
        for (const r of (ctrl ?? [])) controlHoldoutIds.add((r as any).player_id);
      }
    } catch { /* pre-migration 007 — table doesn't exist yet */ }

    // ── 7. Contact-budget settings from rule (with fallback defaults) ─────────
    // Cancellation notices are ALWAYS exempt from budget — they are transactional
    // and must never be suppressed.  applies_to=['promotion'] only.
    interface ContactBudget { cooldown_days: number; max_per_30_days: number; max_sends_per_decision?: number; applies_to: string[]; }
    // max_sends_per_decision: rank cutoff, not a filter. All candidates keep their
    // score and rank; those beyond the cap are marked below the send line so the
    // operator can see the full list and where the cutoff falls.
    // Defaults: 25 for clinics, 40 for open play (opening positions — not derived).
    // Capacity permits ~97/session; that is not a reason to send 97.
    const BUDGET_DEFAULTS: ContactBudget = { cooldown_days: 7, max_per_30_days: 2, max_sends_per_decision: 25, applies_to: ["promotion"] };
    let contactBudget: ContactBudget = BUDGET_DEFAULTS;
    {
      const { data: ruleRow } = await supabase
        .from("programming_rules")
        .select("contact_budget")
        .eq("id", (dec as any).rule_id)
        .maybeSingle();
      if (ruleRow?.contact_budget) contactBudget = { ...BUDGET_DEFAULTS, ...(ruleRow.contact_budget as any) };
    }

    // ── 7b. Load 30-day promotional contact history from ledger ───────────────
    // Query at the club level once, then index per-player in memory.
    // Cancellations are stored in the ledger (purpose='cancellation') but are
    // deliberately excluded here — they must never count against a player's
    // promotional budget.
    const ledgerCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { data: ledgerRows, error: ledgerReadErr } = await supabase
      .from("contact_ledger")
      .select("player_id, sent_at")
      .eq("club_id", clubId)
      .eq("purpose", "promotion")   // cancellations are EXEMPT — never budgeted
      .gte("sent_at", ledgerCutoff);
    if (ledgerReadErr) {
      // FAIL CLOSED: an unreadable ledger means the budget gate would silently
      // see an empty history and allow over-contacting players.
      logger.error({ err: ledgerReadErr.message, clubId },
        "[programming/candidates] contact_ledger read FAILED — aborting build (budget gate would be blind)");
      throw new Error(`contact_ledger read failed: ${ledgerReadErr.message}`);
    }

    interface ContactSummary { lastSentAt: Date | null; count30d: number; }
    const contactMap = new Map<string, ContactSummary>();
    for (const row of (ledgerRows ?? [])) {
      const prev = contactMap.get((row as any).player_id) ?? { lastSentAt: null, count30d: 0 };
      const sentAt = new Date((row as any).sent_at);
      if (!prev.lastSentAt || sentAt > prev.lastSentAt) prev.lastSentAt = sentAt;
      prev.count30d++;
      contactMap.set((row as any).player_id, prev);
    }

    // ── 7c. Legacy 48h flag from messages (visibility only — not a gate) ───────
    const cutoff48h = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const { data: recentMessages } = await supabase
      .from("messages")
      .select("player_id:conversations(player_id)")
      .eq("direction", "outbound")
      .gte("sent_at", cutoff48h)
      .not("status", "eq", "failed");
    const contactedRecently = new Set<string>(
      (recentMessages ?? []).map((m: any) => m.player_id?.player_id).filter(Boolean)
    );

    // ── 8. Filter + score each player ─────────────────────────────────────────
    const sendLineCap = contactBudget.max_sends_per_decision ?? 25;
    const funnel = {
      total_players:          players.length,
      after_already_booked:   0,
      after_level_fit:        0,
      after_long_dormant:     0,   // replaces engagement + archetype gates
      segment_counts:         { active: 0, lapsing: 0, recent_dormant: 0, unknown: 0 },
      after_contact_budget:   0,
      eligible_final:         0,
      sms_reachable:          0,
      email_only:             0,
      flagged_contacted_48h:  0,
      contact_budget_settings: contactBudget,
      // Send-line: rank cutoff applied after scoring. Candidates above line are
      // those the operator would actually send to. Candidates below keep their
      // score and rank — they are visible but not within the active cap.
      send_line_cap:          sendLineCap,
      above_send_line:        0,
    };

    const candidates: any[] = [];

    for (const p of players) {
      // 5. Already booked — skip entirely
      if (p.external_id && bookedExternalIds.has(p.external_id)) continue;
      if (signedUpPlayerIds.has(p.id)) continue;
      funnel.after_already_booked++;

      let eligible = true;
      const reasons: Record<string, any> = {};
      let score = 0;
      let ineligibleReason: string | null = null;

      // 1. Level fit — level-gated events are excluded from outreach entirely.
      // PodPlay admission ratings are DUPR-scale (e.g. 3.75); player levels are
      // word tags on a 1–5 scale and mostly null. Eligibility cannot be
      // verified, and inviting a player below the gate is worse than inviting
      // no one. (Mirrors buildExperimentCandidates in experiments.ts.)
      if (admissionMin !== null || admissionMax !== null) {
        eligible = false;
        ineligibleReason =
          `level-gated event (admission min=${admissionMin ?? "—"}${admissionMax !== null ? `, max=${admissionMax}` : ""}) — ` +
          `outreach disabled: player DUPR data unavailable, eligibility cannot be verified`;
      }
      if (eligible) funnel.after_level_fit++;

      // 2. Retention segmentation — replaces both the engagement gate and archetype gate.
      //
      // Segment by recency (days since last visit):
      //   active         ≤14d  → eligible, lowest priority (they're coming anyway)
      //   lapsing        15–30d → eligible, HIGHEST priority (habit intact, best ROI)
      //   recent_dormant 31–90d → eligible, high priority (genuine win-back opportunity)
      //   long_dormant    91+d  → excluded — different copy, offer, cadence needed
      //   unknown        (null) → eligible, treated conservatively (new/unsynced member)
      //
      // Long-dormant is the ONLY hard gate introduced here.
      // Engagement state and archetype are no longer eligibility gates.
      const daysSinceVisit = p.last_visit_date
        ? (Date.now() - new Date(p.last_visit_date).getTime()) / 86_400_000
        : null;
      const retentionSegment: "active" | "lapsing" | "recent_dormant" | "long_dormant" | "unknown" =
        daysSinceVisit === null ? "unknown"
        : daysSinceVisit <= 14  ? "active"
        : daysSinceVisit <= 30  ? "lapsing"
        : daysSinceVisit <= 90  ? "recent_dormant"
        :                         "long_dormant";
      reasons.retention_segment  = retentionSegment;
      reasons.days_since_visit   = daysSinceVisit !== null ? Math.round(daysSinceVisit) : null;
      reasons.churn_risk         = p.churn_risk ?? null;  // visible, not filtering

      if (eligible && retentionSegment === "long_dormant") {
        eligible = false;
        ineligibleReason = `long_dormant: ${Math.round(daysSinceVisit!)}d since last visit — win-back motion only`;
      } else if (eligible) {
        funnel.after_long_dormant++;
        if      (retentionSegment === "active")         funnel.segment_counts.active++;
        else if (retentionSegment === "lapsing")        funnel.segment_counts.lapsing++;
        else if (retentionSegment === "recent_dormant") funnel.segment_counts.recent_dormant++;
        else                                            funnel.segment_counts.unknown++;
      }

      // 3. Segment ranking score — lapsing/recent-dormant outrank active.
      // Rationale: warm score contributes ×10 (range −30→+40). Segment bonus of +25/+15
      // for lapsing/recent-dormant is large enough to prioritise them over active
      // regulars with equivalent warm scores, but a strong warm=4 active player
      // (+40) still outranks a cold lapsing player (−30 + 25 = −5).
      if (eligible) {
        const segmentScore =
          retentionSegment === "lapsing"        ? 25 :
          retentionSegment === "recent_dormant" ? 15 :
          retentionSegment === "unknown"        ? 5  : 0;  // active = 0
        score += segmentScore;
        if (segmentScore > 0) reasons.segment_score = segmentScore;
      }

      // 3b. Archetype as a soft ranking signal (no longer a gate).
      // 'default' (2,117 / 2,506 players) is explicitly neutral — not penalized.
      // At long-lead checkpoints (T-12h+): early/planner get a small bonus.
      // At short-lead checkpoints (T-11h−): late gets a small bonus.
      // This reflects when they are *likely to act*, not whether they can be reached.
      if (eligible) {
        const arch = (p.attendance_archetype ?? "default").toLowerCase();
        const isLongLead = checkpointOffsetHours >= 12;
        let archetypeScore = 0;
        if (isLongLead  && (arch === "early" || arch === "planner")) archetypeScore = 5;
        if (!isLongLead && arch === "late")                          archetypeScore = 5;
        score += archetypeScore;
        reasons.archetype_signal = archetypeScore !== 0
          ? `${arch}:+${archetypeScore}`
          : arch;
      }

      // 3b. Contact budget gate
      // IMPORTANT: cancellation notices are ALWAYS exempt from budget logic.
      // This gate only applies when purpose='promotion' is in contactBudget.applies_to.
      // The budget is enforced by querying contact_ledger (not messages) — the
      // ledger is the single source of truth for promotional contact frequency.
      if (eligible) {
        const cooldownMs  = contactBudget.cooldown_days * 86_400_000;
        const cooldownCutoff = new Date(Date.now() - cooldownMs);
        const cs = contactMap.get(p.id);
        if (cs?.lastSentAt && cs.lastSentAt > cooldownCutoff) {
          eligible = false;
          const daysAgo = Math.round((Date.now() - cs.lastSentAt.getTime()) / 86_400_000);
          ineligibleReason = `contact_cooldown: last promoted ${daysAgo}d ago (cooldown=${contactBudget.cooldown_days}d)`;
          reasons.contact_exclusion = ineligibleReason;
        } else if (cs && cs.count30d >= contactBudget.max_per_30_days) {
          eligible = false;
          ineligibleReason = `contact_30d_cap: ${cs.count30d} promotions in last 30d (max=${contactBudget.max_per_30_days})`;
          reasons.contact_exclusion = ineligibleReason;
        } else {
          funnel.after_contact_budget++;
          reasons.last_contact_date  = cs?.lastSentAt?.toISOString() ?? null;
          reasons.contact_count_30d  = cs?.count30d ?? 0;
        }
      }

      // 4. Slot fit scoring (does not gate eligibility)
      if (p.preferred_booking_dow !== null && p.preferred_booking_dow === eventDow) {
        score += 5;
        reasons.slot_dow_match = `preferred DOW ${p.preferred_booking_dow} matches event`;
      }
      if (p.preferred_booking_hour !== null &&
          Math.abs(p.preferred_booking_hour - eventHour) <= 2) {
        score += 3;
        reasons.slot_hour_match = `preferred hour ${p.preferred_booking_hour} ≈ event ${eventHour}`;
      }

      // 2. Program affinity scoring — warm score computed post-loop for eligible
      //    candidates only (Phase 3.3). The stale players.warm_score cache is not
      //    used here; see the post-loop block below.

      // 5d. Buddy signal
      const buddies = buddyMap.get(p.id);
      if (buddies && buddies.length > 0) {
        score += 20;
        reasons.buddy_already_signed_up = buddies.length;
      }

      // 6. Consent
      const smsOk = p.sms_opt_in === true && p.opted_out !== true;
      reasons.sms_reachable = smsOk;

      // 5e. Send budget — flag only, do not suppress
      const contactedRecent = contactedRecently.has(p.id);
      if (contactedRecent) {
        reasons.flagged_contacted_48h = true;
        funnel.flagged_contacted_48h++;
      }

      if (eligible) {
        funnel.eligible_final++;
        if (smsOk) funnel.sms_reachable++;
        else       funnel.email_only++;
      }

      candidates.push({
        player_id: p.id,
        player_name: p.name,
        eligible,
        ineligible_reason: ineligibleReason,
        score,
        reasons,
        sms_opt_in: smsOk,
      });
    }

    // ── 8b. Compute warm scores for eligible candidates ───────────────────────
    // Done AFTER the archetype gate so we only pay per-player DB costs for the
    // surviving ~24 players. skipCache=true prevents writing back to
    // players.warm_score — the score is event-class-specific and stored in
    // reasons.warm_score_built instead.
    {
      const eligible = candidates.filter((c) => c.eligible);
      await Promise.all(
        eligible.map(async (c) => {
          try {
            const ws = await computeWarmScore(
              c.player_id,
              programType ?? "",
              programName,
              { skipCache: true, programStartDate: eventStartDate },
            );
            c.score += Math.round(ws * 10);
            c.reasons.warm_score_built        = ws;
            c.reasons.warm_score_program_type = programType ?? "unknown";
          } catch { /* non-fatal — leave warm score absent */ }
        }),
      );
    }

    // ── 8c. Recency adjustment — rotation tiebreaker for eligible candidates ──
    // Cancellations are EXEMPT and never counted here.  contactMap contains
    // promotional contacts only (purpose='promotion', loaded in step 7b).
    //
    // Weight rationale: warm score contributes ×10 (≈ −30 to +40 range), slot
    // fit +8 max, buddy +20.  Recency max +15 makes it a meaningful tiebreaker
    // between adjacent-score players without pushing a warm=0 candidate above
    // a warm=4 one.  The operator can see base_score vs. recency_adjustment to
    // judge when rotation changed the order.
    //
    // Breakpoints (in days since last promotional contact via the ledger):
    //   never contacted   → +15  (strongest rotation bonus)
    //   > 30 d            → +8   (moderate; safe to re-contact)
    //   15 – 30 d         → +3   (slight preference over recently-contacted)
    //   < 15 d (but outside cooldown window) → 0
    //   within cooldown   → excluded above; never reaches here
    {
      for (const c of candidates.filter((cc) => cc.eligible)) {
        const cs = contactMap.get(c.player_id);
        c.reasons.base_score = c.score;  // snapshot before recency

        let recencyAdj = 0;
        let recencyBasis = "never_contacted";
        if (!cs?.lastSentAt) {
          recencyAdj = 15;
        } else {
          const daysSince = (Date.now() - cs.lastSentAt.getTime()) / 86_400_000;
          recencyBasis = `${Math.round(daysSince)}d_since_contact`;
          if (daysSince > 30)      recencyAdj = 8;
          else if (daysSince > 14) recencyAdj = 3;
          else                     recencyAdj = 0;
        }
        c.reasons.recency_adjustment = recencyAdj;
        c.reasons.recency_basis      = recencyBasis;
        c.score += recencyAdj;
      }
    }

    // ── 9. Sort eligible candidates by score desc; ineligible go after ────────
    candidates.sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return b.score - a.score;
    });

    // Assign ranks (eligible only) and apply send-line cutoff.
    // max_sends_per_decision is a rank cap, not a filter — candidates beyond the
    // cutoff stay in the list with scores and ranks intact. The operator sees the
    // full sorted list and where the line falls.
    let rank = 1;
    const toStore: any[] = [];
    for (const c of candidates) {
      if (c.eligible) {
        c.rank = rank++;
        c.above_send_line = c.rank <= sendLineCap;
        c.reasons.above_send_line = c.above_send_line;
        if (c.above_send_line) funnel.above_send_line++;
      } else {
        c.rank = null;
        c.above_send_line = false;
      }
      if (c.eligible || c.ineligible_reason) {
        toStore.push({
          decision_id:       decisionId,
          player_id:         c.player_id,
          rank:              c.rank ?? 9999,
          score:             c.score,
          reasons:           c.reasons,
          eligible:          c.eligible,
          ineligible_reason: c.ineligible_reason ?? null,
          above_send_line:   c.above_send_line ?? false,
        });
      }
    }

    // ── 10. Persist to promotion_candidates (best-effort; table may not exist yet) ──
    let stored = false;
    if (toStore.length > 0) {
      try {
        const BATCH = 100;
        for (let i = 0; i < toStore.length; i += BATCH) {
          await supabase
            .from("promotion_candidates")
            .upsert(toStore.slice(i, i + BATCH), {
              onConflict: "decision_id,player_id",
              ignoreDuplicates: false,
            });
        }
        stored = true;
      } catch {
        // Table doesn't exist yet (pre-migration 006) — return results without storing
      }
    }

    res.json({
      decision_id: decisionId,
      event_id:    eventId,
      event_name:  (dec as any).event_name,
      event_start: eventStartIso,
      admission_rating: admissionMin !== null ? { min: admissionMin, max: admissionMax } : null,
      capacity,
      current_signups: (dec as any).signup_count,
      booked_externally: bookedExternalIds.size,
      stored_to_db: stored,
      funnel,
      eligible_count:   funnel.eligible_final,
      candidates:       candidates.slice(0, 200), // show enough to always include send-line boundary
      total_candidates: candidates.length,
      send_line_cap:    sendLineCap,
    });

  } catch (err: any) {
    logger.error({ err }, "[programming/promotion-candidates] error");
    res.status(500).json({ error: err.message });
  }
});

export default router;


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

const JOB_EVAL        = "programming_evaluate";
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

// ── GET /api/programming/decisions ────────────────────────────────────────────
//
// Query params: clubId (uuid), limit (default 50), offset (default 0)

router.get("/programming/decisions", async (req, res) => {
  const clubId = req.query.clubId as string;
  if (!clubId) { res.status(400).json({ error: "clubId required" }); return; }

  const limit  = Math.min(parseInt(req.query.limit  as string || "50", 10), 200);
  const offset = parseInt(req.query.offset as string || "0",  10);

  const { data, error, count } = await supabase
    .from("programming_decisions")
    .select("*", { count: "exact" })
    .eq("club_id", clubId)
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
// NOTE: keywords and podplay_types matching requires the event name/type,
// which is not stored in event_fill. Only archetype_ids filter is applied.
// See task #9 for full rule-matching support.
//
// Body: {
//   clubId: string,
//   rule: {
//     match_rules: { archetype_ids?, keywords?, podplay_types? },
//     checkpoints: [{ index, offset_hours, min_signups, action }]
//   },
//   days?: number              (default 120, max 365)
//   includeEventDetails?: bool (default true; set false for sweep iterations)
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
      index:        z.number().int(),
      offset_hours: z.number().int(),
      min_signups:  z.number().int(),
      action:       z.enum(["CANCEL", "ALERT"]),
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
    let fillRows: any[] = [];
    let fillPage = 0;
    while (true) {
      const { data, error } = await supabase
        .from("event_fill")
        .select("event_id, archetype_id, final_signups, total_teams, fill_rate, start_time")
        .eq("club_id", clubId)
        .eq("is_canceled", false)
        .not("archetype_id", "is", null)
        .gte("start_time", cutoff)
        .lt("start_time",  nowIso)
        .range(fillPage * 500, (fillPage + 1) * 500 - 1);
      if (error) { res.status(500).json({ error: error.message }); return; }
      if (!data?.length) break;
      fillRows.push(...data);
      if (data.length < 500) break;
      fillPage++;
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
    const checkpointResults: any[] = [];
    const keywordsWarn = (rule.match_rules.keywords?.length ?? 0) > 0
      || (rule.match_rules.podplay_types?.length ?? 0) > 0;

    for (const cp of rule.checkpoints) {
      let evaluated = 0, wouldFire = 0, tp = 0, fp = 0;
      let skippedCoverage = 0, skippedUndercount = 0, skippedNoData = 0;
      const byArchetype: Record<string, { evaluated: number; wouldFire: number; tp: number; fp: number }> = {};
      const eventDetails: any[] = [];
      const usableRowCounts: number[] = [];

      for (const fill of fillRows) {
        // Match — archetype_ids only; keywords/podplay_types require event
        // name/type not stored in event_fill (task #9)
        const mr = rule.match_rules;
        if (mr.archetype_ids?.length && !mr.archetype_ids.includes(fill.archetype_id)) continue;

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
        usableRowCounts.push(att.total);

        const fires = signupAtOffset < cp.min_signups;
        // Outcome proxy: final fill_rate < 0.5 → session was genuinely at risk.
        // Ground truth would be the actual cancellation outcome — see task #10.
        const actuallyAtRisk = fill.fill_rate !== null && (fill.fill_rate as number) < 0.5;

        if (!byArchetype[archName]) byArchetype[archName] = { evaluated: 0, wouldFire: 0, tp: 0, fp: 0 };
        const ab = byArchetype[archName];
        evaluated++; ab.evaluated++;
        if (fires) {
          wouldFire++; ab.wouldFire++;
          if (actuallyAtRisk) { tp++; ab.tp++; }
          else                { fp++; ab.fp++; }
        }

        if (includeEventDetails) {
          eventDetails.push({
            event_id:          fill.event_id,
            program_name:      att.programName ?? archName,
            date:              (fill.start_time as string)?.slice(0, 10) ?? null,
            archetype:         archName,
            count_at_offset:   signupAtOffset,
            final_signups:     fill.final_signups,
            booked_at_coverage: Math.round(coverage * 1000) / 1000,
            would_fire:        fires,
            outcome_at_risk:   actuallyAtRisk,
            is_tp:             fires && actuallyAtRisk,
            is_fp:             fires && !actuallyAtRisk,
          });
        }
      }

      // Quantization uncertainty: a 1-signup swing at median n rows/event
      const sortedUR    = [...usableRowCounts].sort((a, b) => a - b);
      const medUR       = sortedUR.length ? sortedUR[Math.floor(sortedUR.length / 2)] : null;
      const uncertainty = medUR !== null && medUR > 0
        ? `±${Math.round(100 / medUR)}pp (1-signup at median ${medUR} rows/event)`
        : "unknown";

      checkpointResults.push({
        checkpoint_index:     cp.index,
        offset_hours:         cp.offset_hours,
        min_signups:          cp.min_signups,
        action:               cp.action,
        evaluated,
        would_fire:           wouldFire,
        true_positives:       tp,
        false_positives:      fp,
        skipped_low_coverage: skippedCoverage,
        skipped_undercount:   skippedUndercount,
        skipped_no_data:      skippedNoData,
        fire_rate:   evaluated > 0 ? Math.round(wouldFire / evaluated * 1000) / 1000 : null,
        fp_rate:     wouldFire  > 0 ? Math.round(fp / wouldFire  * 1000) / 1000 : null,
        median_usable_rows: medUR,
        uncertainty_band:   uncertainty,
        by_archetype:       byArchetype,
        ...(includeEventDetails ? { event_details: eventDetails } : {}),
      });
    }

    res.json({
      days,
      total_events_in_window: fillRows.length,
      archetype_coverage:     archetypeCoverage,
      reconstruction_note:
        "signup_count_at_offset reconstructed from attendances.booked_at (member-tracked subset only). " +
        "Archetypes with median local/PodPlay ratio < 0.70 are excluded from checkpoint results.",
      ...(keywordsWarn ? {
        keywords_note:
          "WARNING: keywords and podplay_types filters were NOT applied — " +
          "event names are not stored in event_fill. Only archetype_ids matching used. See task #9.",
      } : {}),
      checkpoints: checkpointResults,
    });

  } catch (err: any) {
    logger.error({ err }, "[programming/backtest] error");
    res.status(500).json({ error: err.message });
  }
});

export default router;

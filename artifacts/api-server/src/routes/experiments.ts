/**
 * Outreach Experiment Module — Phase 4
 *
 * Endpoints:
 *   GET  /api/experiments/eligible-sessions   — upcoming PROMOTE decisions usable as experiment targets
 *   POST /api/experiments/preview             — pool size + balance preview (no DB write)
 *   POST /api/experiments                     — create experiment, randomize, draft messages
 *   GET  /api/experiments                     — list experiments for club
 *   GET  /api/experiments/:id                 — experiment + all participants
 *   POST /api/experiments/:id/veto/:pid       — veto a participant (removes from both arms)
 *   PATCH /api/experiments/:id/participants/:pid — update message text
 *   POST /api/experiments/:id/mark-sent       — mark participants sent, write contact_ledger
 *   POST /api/experiments/:id/measure         — run outcome measurement job
 *   GET  /api/experiments/:id/measure/status  — poll measurement job
 *
 * Hard constraints (never relaxed):
 *   - No Twilio calls. No automated sending.
 *   - No PodPlay writes.
 *   - Supabase writes limited to experiment tables + contact_ledger only.
 *   - Phone numbers are NEVER echoed in report/pooled output; shown only to operator in detail view.
 */

import { Router } from "express";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { supabase } from "../lib/supabaseClient";
import { computeWarmScore } from "../lib/warmScore";
import { sendViaTwilio } from "../lib/twilio";
import { logger } from "../lib/logger";

const router = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Seeded PRNG (mulberry32). Returns a function producing [0, 1). */
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle using a seeded PRNG. Does not mutate the input. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface ArmStats {
  meanScore: number;
  lapsingPct: number;
  dormantPct: number;
  meanDaysSince: number | null;
  n: number;
}

function armStats(participants: any[]): ArmStats {
  const n = participants.length;
  if (n === 0) return { meanScore: 0, lapsingPct: 0, dormantPct: 0, meanDaysSince: null, n: 0 };
  const meanScore = participants.reduce((s, p) => s + (p.score ?? 0), 0) / n;
  const lapsing   = participants.filter(p => p.reasons?.retention_segment === "lapsing").length;
  const dormant   = participants.filter(p => p.reasons?.retention_segment === "recent_dormant").length;
  const days      = participants.map(p => p.reasons?.days_since_visit).filter((d): d is number => d !== null && d !== undefined);
  const meanDays  = days.length > 0 ? days.reduce((s, d) => s + d, 0) / days.length : null;
  return {
    meanScore:    Math.round(meanScore * 10) / 10,
    lapsingPct:   Math.round((lapsing / n) * 100),
    dormantPct:   Math.round((dormant / n) * 100),
    meanDaysSince: meanDays !== null ? Math.round(meanDays) : null,
    n,
  };
}

function checkBalance(treatment: any[], control: any[]): { balanced: boolean; reason: string | null } {
  const t = armStats(treatment);
  const c = armStats(control);
  const scoreDiff   = Math.abs(t.meanScore - c.meanScore);
  const lapsingDiff = Math.abs(t.lapsingPct - c.lapsingPct);
  const daysDiff    = t.meanDaysSince !== null && c.meanDaysSince !== null
    ? Math.abs(t.meanDaysSince - c.meanDaysSince) : 0;
  if (scoreDiff > 20)  return { balanced: false, reason: `mean score differs by ${scoreDiff.toFixed(1)} (treatment ${t.meanScore} vs control ${c.meanScore})` };
  if (lapsingDiff > 15) return { balanced: false, reason: `lapsing% differs by ${lapsingDiff}pp (treatment ${t.lapsingPct}% vs control ${c.lapsingPct}%)` };
  if (daysDiff > 15)   return { balanced: false, reason: `days-since-visit differs by ${Math.round(daysDiff)}d` };
  return { balanced: true, reason: null };
}

/** Format an event start for display in messages (local time using club timezone). */
function formatEventSlot(eventStartIso: string, timezone: string): { dayName: string; timeStr: string; shortDate: string } {
  const dt = new Date(eventStartIso);
  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, ...opts }).format(dt);
  const dayName  = fmt({ weekday: "long" });
  const timeStr  = fmt({ hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase().replace(/ /g, "");
  const shortDate = fmt({ month: "short", day: "numeric" });
  return { dayName, timeStr, shortDate };
}

/**
 * Draft an SMS message for a treatment participant.
 * Rules: no em-dashes, no exclamation points, contractions always, 1-3 sentences,
 * one ask, no discounts, no urgency, no surveillance framing.
 */
function draftMessage(opts: {
  playerName:      string;
  segment:         "lapsing" | "recent_dormant";
  daysSince:       number | null;
  buddyCount:      number;
  dayName:         string;
  timeStr:         string;
  sessionName:     string;
  bookingLink:     string;
}): string {
  const { playerName, segment, daysSince, buddyCount, dayName, timeStr, sessionName, bookingLink } = opts;
  const first = playerName?.split(" ")[0] ?? "Hey";

  // Buddy variant — takes priority over segment framing
  if (buddyCount >= 1) {
    const buddyWord = buddyCount === 1 ? "a buddy of yours is" : "some of your usual crew are";
    return `Hey ${first}, ${buddyWord} playing ${sessionName} this ${dayName} at ${timeStr} -- there's still room if you'd like to join. ${bookingLink}`;
  }

  if (segment === "lapsing") {
    return `Hey ${first}, haven't seen you in a couple weeks -- ${sessionName} this ${dayName} at ${timeStr} has room and we'd love to have you back. ${bookingLink}`;
  }

  // recent_dormant (31-90d)
  const weeksAgo = daysSince ? Math.round(daysSince / 7) : null;
  const gapPhrase = weeksAgo && weeksAgo >= 6
    ? `it's been a while`
    : `it's been a few weeks`;
  return `Hey ${first}, ${gapPhrase} -- ${sessionName} this ${dayName} at ${timeStr} has open spots if you're looking to get back on the courts. ${bookingLink}`;
}

// ─── Level-gate recheck at send time ─────────────────────────────────────────
// Level-gated events are excluded from outreach entirely (see
// buildExperimentCandidates). This recheck protects experiments created BEFORE
// that rule existed (or if PodPlay adds a gate after creation). Fails CLOSED:
// if the event cannot be fetched, dispatch is blocked rather than risking a
// send to unverifiable recipients.
async function checkEventLevelGate(
  apiBase: string, apiKey: string, eventId: string,
): Promise<{ gated: boolean; min: number | null; max: number | null; fetchError: string | null }> {
  try {
    const er = await fetch(`${apiBase}/events/${eventId}`, { headers: { "x-api-key": apiKey } });
    if (!er.ok) return { gated: false, min: null, max: null, fetchError: `PodPlay event fetch failed (${er.status})` };
    const ed: any = await er.json();
    const min = ed?.admissionRating?.minRating ?? null;
    const max = ed?.admissionRating?.maxRating ?? null;
    return { gated: min !== null || max !== null, min, max, fetchError: null };
  } catch (err: any) {
    return { gated: false, min: null, max: null, fetchError: err.message };
  }
}

function levelGateMessage(min: number | null, max: number | null): string {
  return `This event has a level gate (admission rating min=${min ?? "—"}` +
    `${max !== null ? `, max=${max}` : ""}). Player DUPR data is not available, so eligibility ` +
    `cannot be verified — level-gated events are excluded from outreach.`;
}

const LEVEL_NUMERIC: Record<string, number> = {
  beginner: 1, advanced_beginner: 2, "advanced beginner": 2,
  intermediate: 3, "low intermediate": 3,
  advanced_intermediate: 4, "advanced intermediate": 4,
  advanced: 5,
};

// ─── Core candidate builder (experiment-specific) ─────────────────────────────
// Reuses the same filtering logic as the promotion candidate builder but with
// stricter experiment eligibility: lapsing + recent_dormant only (no active,
// no unknown), SMS-reachable as a hard gate (not just scoring), and slot fit
// reported separately.

async function buildExperimentCandidates(opts: {
  clubId:       string;
  decisionId:   string;
  apiBase:      string;
  apiKey:       string;
  timezone:     string;
  subdomain:    string;
}) {
  const { clubId, decisionId, apiBase, apiKey, timezone, subdomain } = opts;

  // 1. Load decision for event context
  const { data: dec } = await supabase
    .from("programming_decisions")
    .select("*")
    .eq("id", decisionId)
    .maybeSingle();
  if (!dec) throw new Error("Decision not found");

  // Derive eventId from decision (not passed in opts to avoid circular ref)
  const eventId = (dec as any).event_id as string;

  const eventStartIso = (dec as any).event_start_time as string;
  const eventStartDate = new Date(eventStartIso);
  const eventDow  = eventStartDate.getUTCDay();
  const eventHour = eventStartDate.getUTCHours();
  const checkpointOffsetHours = (dec as any).checkpoint_offset_hours as number ?? 18;
  const programName = (dec as any).event_name as string ?? "";

  // 2. Event detail (admission rating)
  let admissionMin: number | null = null, admissionMax: number | null = null;
  try {
    const er = await fetch(`${apiBase}/events/${eventId}`, { headers: { "x-api-key": apiKey } });
    if (er.ok) {
      const ed: any = await er.json();
      admissionMin = ed?.admissionRating?.minRating ?? null;
      admissionMax = ed?.admissionRating?.maxRating ?? null;
    }
  } catch { /* best-effort */ }

  // Level-gated events are EXCLUDED from outreach entirely.
  //
  // PodPlay admission ratings are DUPR-scale (e.g. minRating=3.75); our player
  // level data is word tags on a 1–5 scale (beginner … advanced) and is null
  // for the vast majority of players. There is no defensible mapping between
  // the two, so we cannot verify that any player meets the gate. Inviting a
  // player below a level gate is worse than not inviting anyone, so the whole
  // event is excluded until real DUPR data exists for players.
  //
  // (The old per-player check required BOTH minRating and maxRating to be
  // non-null and silently passed players with null levels — a 3.75+ event
  // with no maxRating was never filtered at all.)
  const levelGated = admissionMin !== null || admissionMax !== null;

  // 3. Program type for warm score
  const { data: fillRow } = await supabase.from("event_fill").select("podplay_type").eq("event_id", eventId).maybeSingle();
  const ruleName = (dec as any).rule_name as string ?? "";
  const programType =
    fillRow?.podplay_type ??
    (ruleName.toLowerCase().includes("clinic") ? "Clinics" :
     ruleName.toLowerCase().includes("open play") ? "Open Play" : null);

  // 4. Live signups from PodPlay (to exclude already-booked)
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
  } catch { /* best-effort */ }

  // 5. Load players
  const players: any[] = [];
  let offset = 0;
  while (true) {
    const { data: pg, error: pgErr } = await supabase
      .from("players")
      .select(
        "id, external_id, name, phone, sms_opt_in, opted_out, churn_risk, last_visit_date, " +
        "coach_assigned_level, skill_level, attendance_archetype, " +
        "preferred_booking_dow, preferred_booking_hour"
      )
      .eq("club_id", clubId)
      .not("external_id", "is", null)
      .range(offset, offset + 999);
    if (pgErr || !pg?.length) break;
    players.push(...pg);
    if (pg.length < 1000) break;
    offset += 1000;
  }

  // 6. Resolve booked external IDs → internal UUIDs (buddy signal)
  const signedUpPlayerIds = new Set<string>();
  if (bookedExternalIds.size > 0) {
    const extArr = [...bookedExternalIds];
    for (let ci = 0; ci < extArr.length; ci += 200) {
      const { data: rows } = await supabase.from("players").select("id")
        .eq("club_id", clubId).in("external_id", extArr.slice(ci, ci + 200));
      for (const r of (rows ?? [])) signedUpPlayerIds.add((r as any).id);
    }
  }

  // 7. Buddy map (signed-up players' buddy partners)
  const buddyMap = new Map<string, string[]>();
  const signedUpArr = [...signedUpPlayerIds];
  if (signedUpArr.length > 0) {
    for (let ci = 0; ci < signedUpArr.length; ci += 100) {
      const chunk = signedUpArr.slice(ci, ci + 100);
      const { data: pairs } = await supabase.from("buddy_pairs").select("player_a, player_b")
        .or(`player_a.in.(${chunk.join(",")}),player_b.in.(${chunk.join(",")})`)
      for (const pair of (pairs ?? [])) {
        const { player_a, player_b } = pair as any;
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

  // 8. Contact ledger (30-day promotional history)
  // FAIL CLOSED: if the ledger cannot be read, the budget gate would silently
  // see an empty history and allow over-contacting. Abort the build instead.
  // (Note: supabase-js does NOT throw on query errors — the error must be
  // checked explicitly; a try/catch alone is dead code here.)
  const ledgerCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: ledgerData, error: ledgerReadErr } = await supabase.from("contact_ledger")
    .select("player_id, sent_at").eq("club_id", clubId)
    .eq("purpose", "promotion").gte("sent_at", ledgerCutoff);
  if (ledgerReadErr) {
    logger.error({ err: ledgerReadErr.message, clubId },
      "[experiments/candidates] contact_ledger read FAILED — aborting build (budget gate would be blind)");
    throw new Error(`contact_ledger read failed: ${ledgerReadErr.message}`);
  }
  const ledgerRows: any[] = ledgerData ?? [];

  const contactMap = new Map<string, { lastSentAt: Date | null; count30d: number }>();
  for (const row of ledgerRows) {
    const prev = contactMap.get(row.player_id) ?? { lastSentAt: null, count30d: 0 };
    const sentAt = new Date(row.sent_at);
    if (!prev.lastSentAt || sentAt > prev.lastSentAt) prev.lastSentAt = sentAt;
    prev.count30d++;
    contactMap.set(row.player_id, prev);
  }

  // 9. Control holdout — exclude active experiment control arm members.
  // FAIL CLOSED: a silent read failure here would put control-arm players back
  // into candidate pools and contaminate running experiments.
  const controlHoldoutIds = new Set<string>();
  {
    const holdoutCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { data: activeExps, error: expReadErr } = await supabase.from("outreach_experiments")
      .select("id").eq("club_id", clubId)
      .in("status", ["ready", "sent", "measuring"]).gte("randomized_at", holdoutCutoff);
    if (expReadErr) {
      logger.error({ err: expReadErr.message, clubId },
        "[experiments/candidates] active-experiments read FAILED — aborting build (control holdout would be lost)");
      throw new Error(`active experiments read failed: ${expReadErr.message}`);
    }
    if (activeExps && activeExps.length > 0) {
      const { data: ctrl, error: ctrlReadErr } = await supabase.from("experiment_participants")
        .select("player_id").in("experiment_id", activeExps.map((e: any) => e.id))
        .eq("arm", "control").eq("vetoed", false);
      if (ctrlReadErr) {
        logger.error({ err: ctrlReadErr.message, clubId },
          "[experiments/candidates] control-holdout read FAILED — aborting build (control holdout would be lost)");
        throw new Error(`control holdout read failed: ${ctrlReadErr.message}`);
      }
      for (const r of (ctrl ?? [])) controlHoldoutIds.add((r as any).player_id);
    }
  }

  // 10. Budget defaults — a failed override read falls back to the stricter-
  // is-safer defaults; log it so it is not invisible.
  const BUDGET = { cooldown_days: 7, max_per_30_days: 2 };
  {
    const { data: ruleRow, error: budgetReadErr } = await supabase.from("programming_rules")
      .select("contact_budget").eq("id", (dec as any).rule_id).maybeSingle();
    if (budgetReadErr) {
      logger.warn({ err: budgetReadErr.message },
        "[experiments/candidates] contact_budget override read failed — using defaults {7d, 2/30d}");
    }
    if (ruleRow?.contact_budget) Object.assign(BUDGET, ruleRow.contact_budget);
  }

  const bookingLink = `https://${subdomain}.podplay.app/events/${eventId}`;
  const { dayName, timeStr } = formatEventSlot(eventStartIso, timezone);

  // 11. Filter + score
  const candidates: any[] = [];
  const funnel = {
    total_players:        players.length,
    after_not_booked:     0,
    after_level_fit:      0,
    after_segment:        0,       // only lapsing + recent_dormant pass
    excluded_active:      0,
    excluded_unknown:     0,
    excluded_long_dormant: 0,
    after_sms:            0,
    after_contact_budget: 0,
    control_holdout:      0,
    segment_counts:       { lapsing: 0, recent_dormant: 0 },
  };

  for (const p of levelGated ? [] : players) {
    // Already booked
    if (p.external_id && bookedExternalIds.has(p.external_id)) continue;
    if (signedUpPlayerIds.has(p.id)) continue;
    funnel.after_not_booked++;

    // Control holdout
    if (controlHoldoutIds.has(p.id)) { funnel.control_holdout++; continue; }

    // Level fit — level-gated events never reach this loop (see levelGated above)
    funnel.after_level_fit++;

    // Retention segment — experiment restricts to lapsing + recent_dormant only
    const daysSinceVisit = p.last_visit_date
      ? (Date.now() - new Date(p.last_visit_date).getTime()) / 86_400_000
      : null;
    const seg: string = daysSinceVisit === null ? "unknown"
      : daysSinceVisit <= 14 ? "active"
      : daysSinceVisit <= 30 ? "lapsing"
      : daysSinceVisit <= 90 ? "recent_dormant"
      : "long_dormant";

    if (seg === "active")        { funnel.excluded_active++; continue; }
    if (seg === "unknown")       { funnel.excluded_unknown++; continue; }
    if (seg === "long_dormant")  { funnel.excluded_long_dormant++; continue; }
    funnel.after_segment++;
    if (seg === "lapsing")        funnel.segment_counts.lapsing++;
    if (seg === "recent_dormant") funnel.segment_counts.recent_dormant++;

    // SMS reachable — hard gate for experiments (not just scoring)
    const smsOk = p.sms_opt_in === true && p.opted_out !== true && !!p.phone;
    if (!smsOk) continue;
    funnel.after_sms++;

    // Contact budget gate
    const cooldownCutoff = new Date(Date.now() - BUDGET.cooldown_days * 86_400_000);
    const cs = contactMap.get(p.id);
    if (cs?.lastSentAt && cs.lastSentAt > cooldownCutoff) continue;
    if (cs && cs.count30d >= BUDGET.max_per_30_days) continue;
    funnel.after_contact_budget++;

    // Score
    let score = seg === "lapsing" ? 25 : 15; // segment
    const reasons: Record<string, any> = {
      retention_segment: seg,
      days_since_visit:  daysSinceVisit !== null ? Math.round(daysSinceVisit) : null,
      segment_score:     seg === "lapsing" ? 25 : 15,
      sms_reachable:     true,
      contact_count_30d: cs?.count30d ?? 0,
      last_contact_date: cs?.lastSentAt?.toISOString() ?? null,
      recency_basis:     !cs?.lastSentAt ? "never_contacted" : `${Math.round((Date.now() - cs.lastSentAt.getTime()) / 86_400_000)}d_since_contact`,
    };

    // Archetype signal (same weights as promotion builder)
    const arch = (p.attendance_archetype ?? "default").toLowerCase();
    const isLongLead = checkpointOffsetHours >= 12;
    if (isLongLead && (arch === "early" || arch === "planner")) { score += 5; reasons.archetype_signal = `${arch}:+5`; }
    else if (!isLongLead && arch === "late")                    { score += 5; reasons.archetype_signal = `${arch}:+5`; }
    else                                                         { reasons.archetype_signal = arch; }

    // Slot fit (scoring only)
    if (p.preferred_booking_dow !== null && p.preferred_booking_dow === eventDow) {
      score += 5; reasons.slot_dow_match = `preferred DOW ${p.preferred_booking_dow} matches event`;
    }
    if (p.preferred_booking_hour !== null && Math.abs(p.preferred_booking_hour - eventHour) <= 2) {
      score += 3; reasons.slot_hour_match = `preferred hour ${p.preferred_booking_hour} ≈ event ${eventHour}`;
    }

    // Buddy signal
    const buddies = buddyMap.get(p.id);
    if (buddies && buddies.length > 0) { score += 20; reasons.buddy_already_signed_up = buddies.length; }

    // Recency tiebreaker (rotation)
    reasons.base_score = score;
    let recencyAdj = 0;
    if (!cs?.lastSentAt) { recencyAdj = 15; reasons.recency_basis = "never_contacted"; }
    else {
      const daysSince = (Date.now() - cs.lastSentAt.getTime()) / 86_400_000;
      if (daysSince > 30) recencyAdj = 8;
      else if (daysSince > 14) recencyAdj = 3;
    }
    score += recencyAdj;
    reasons.recency_adjustment = recencyAdj;

    candidates.push({
      player_id:    p.id,
      player_name:  p.name,
      phone:        p.phone,
      score,
      reasons,
      segment:      seg,
      days_since:   daysSinceVisit !== null ? Math.round(daysSinceVisit) : null,
      buddy_count:  buddies?.length ?? 0,
    });
  }

  // 12. Warm scores for all candidates
  await Promise.all(candidates.map(async (c) => {
    try {
      const ws = await computeWarmScore(c.player_id, programType ?? "", programName,
        { skipCache: true, programStartDate: eventStartDate });
      c.score += Math.round(ws * 10);
      c.reasons.warm_score_built = ws;
      c.reasons.warm_score_program_type = programType ?? "unknown";
    } catch { /* non-fatal */ }
  }));

  // 13. Sort by score desc
  candidates.sort((a, b) => b.score - a.score);
  candidates.forEach((c, i) => {
    c.rank = i + 1;
    c.reasons.base_score_final = c.score; // for display
  });

  return {
    candidates, funnel, programType, programName, eventStartIso, dayName, timeStr, bookingLink, dec,
    levelGated,
    admission: { min: admissionMin, max: admissionMax },
  };
}

// ─── GET /api/experiments/eligible-sessions ──────────────────────────────────
// Returns upcoming PROMOTE decisions that can be used as experiment targets.

router.get("/experiments/eligible-sessions", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  try {
    const now = new Date().toISOString();
    const { data: decisions } = await supabase
      .from("programming_decisions")
      .select("id, event_id, event_name, event_start_time, rule_name, signup_count, total_teams, checkpoint_offset_hours")
      .eq("club_id", clubId)
      .eq("decision", "PROMOTE")
      .gte("event_start_time", now)
      .order("event_start_time", { ascending: true })
      .limit(20);

    // Filter to decisions not already used by an experiment (pre-migration 007: skip filter)
    let usedDecisionIds = new Set<string>();
    try {
      const { data: existing } = await supabase
        .from("outreach_experiments")
        .select("decision_id")
        .eq("club_id", clubId)
        .not("status", "eq", "draft"); // drafts don't block reuse
      usedDecisionIds = new Set((existing ?? []).map((e: any) => e.decision_id).filter(Boolean));
    } catch { /* pre-migration 007 — allow all decisions */ }

    const available = (decisions ?? []).filter((d: any) => !usedDecisionIds.has(d.id));
    res.json({ decisions: available });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/experiments/preview ──────────────────────────────────────────
// Returns pool size + arms preview without committing anything.

router.post("/experiments/preview", requireClub, async (req, res) => {
  const clubId  = (req as ClubScopedRequest).clubId;
  const { decisionId, treatmentPct = 0.70 } = req.body ?? {};
  if (!decisionId) { res.status(400).json({ error: "decisionId required" }); return; }

  try {
    const { data: club } = await supabase.from("clubs")
      .select("platform_api_key, platform_subdomain, timezone")
      .eq("id", clubId).maybeSingle();
    if (!club?.platform_subdomain) { res.status(500).json({ error: "Club not configured" }); return; }

    const { data: dec } = await supabase.from("programming_decisions")
      .select("event_id").eq("id", decisionId).maybeSingle();
    if (!dec) { res.status(404).json({ error: "Decision not found" }); return; }

    const apiBase = `https://${club.platform_subdomain}.podplay.app/apis/v2`;
    const apiKey  = (club as any).platform_api_key ?? process.env.PODPLAY_API_KEY ?? "";
    const timezone = (club as any).timezone ?? "America/New_York";

    const { candidates, funnel, levelGated, admission } = await buildExperimentCandidates({
      clubId, decisionId,
      apiBase, apiKey, timezone, subdomain: club.platform_subdomain,
    });

    if (levelGated) {
      res.json({
        pool_size: 0, n_treatment: 0, n_control: 0,
        worth_running: false,
        level_gated: true,
        min_pool_note:
          `This event has a level gate (admission rating min=${admission.min ?? "—"}` +
          `${admission.max !== null ? `, max=${admission.max}` : ""}). Player DUPR data is not ` +
          `available, so eligibility cannot be verified — level-gated events are excluded from outreach.`,
        funnel,
        balance: null, treatment_stats: null, control_stats: null,
      });
      return;
    }

    const poolSize = candidates.length;
    const nTreatment = Math.round(poolSize * treatmentPct);
    const nControl   = poolSize - nTreatment;

    // Quick balance preview using a fixed seed
    const shuffled = seededShuffle(candidates, Date.now() % 2147483647);
    const treatmentSample = shuffled.slice(0, nTreatment);
    const controlSample   = shuffled.slice(nTreatment);
    const balance = checkBalance(treatmentSample, controlSample);

    res.json({
      pool_size:    poolSize,
      n_treatment:  nTreatment,
      n_control:    nControl,
      worth_running: poolSize >= 30,
      min_pool_note: poolSize < 30
        ? `Only ${poolSize} candidates qualify — experiment may not be worth running on this session. Consider choosing a different session or waiting for more members to become eligible.`
        : null,
      funnel,
      balance,
      treatment_stats: armStats(treatmentSample),
      control_stats:   armStats(controlSample),
    });
  } catch (err: any) {
    logger.error({ err }, "[experiments/preview] error");
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/experiments ───────────────────────────────────────────────────
// Create experiment, randomize, draft messages, persist to DB.

router.post("/experiments", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { decisionId, name, treatmentPct = 0.70, notes } = req.body ?? {};
  if (!decisionId) { res.status(400).json({ error: "decisionId required" }); return; }

  try {
    const { data: club } = await supabase.from("clubs")
      .select("platform_api_key, platform_subdomain, timezone")
      .eq("id", clubId).maybeSingle();
    if (!club?.platform_subdomain) { res.status(500).json({ error: "Club not configured" }); return; }

    const apiBase  = `https://${club.platform_subdomain}.podplay.app/apis/v2`;
    const apiKey   = (club as any).platform_api_key ?? process.env.PODPLAY_API_KEY ?? "";
    const timezone = (club as any).timezone ?? "America/New_York";
    const subdomain = club.platform_subdomain;

    const { candidates, funnel, programName, eventStartIso, dayName, timeStr, bookingLink, dec, levelGated, admission } =
      await buildExperimentCandidates({
        clubId, decisionId, apiBase, apiKey, timezone, subdomain,
      });

    const eventId = (dec as any).event_id as string;

    if (levelGated) {
      res.status(422).json({
        error:
          `This event has a level gate (admission rating min=${admission.min ?? "—"}` +
          `${admission.max !== null ? `, max=${admission.max}` : ""}). Player DUPR data is not ` +
          `available, so eligibility cannot be verified — level-gated events are excluded from outreach.`,
        level_gated: true,
      });
      return;
    }

    const poolSize = candidates.length;
    if (poolSize === 0) {
      res.status(422).json({ error: "No eligible candidates for this session.", funnel });
      return;
    }

    const nTreatment = Math.round(poolSize * treatmentPct);
    const nControl   = poolSize - nTreatment;

    // Randomize with seed; retry up to 5 times for balance
    let bestSeed = Date.now() % 2147483647;
    let bestShuffled = seededShuffle(candidates, bestSeed);
    let bestBalance = checkBalance(bestShuffled.slice(0, nTreatment), bestShuffled.slice(nTreatment));
    let reseeds = 0;

    if (!bestBalance.balanced) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const trySeed = (bestSeed + attempt * 0x9e3779b9) % 2147483647;
        const tryShuffled = seededShuffle(candidates, trySeed);
        const tryBalance  = checkBalance(tryShuffled.slice(0, nTreatment), tryShuffled.slice(nTreatment));
        if (tryBalance.balanced) {
          bestSeed = trySeed; bestShuffled = tryShuffled; bestBalance = tryBalance;
          reseeds = attempt;
          break;
        }
      }
    }

    const treatmentCands = bestShuffled.slice(0, nTreatment);
    const controlCands   = bestShuffled.slice(nTreatment);

    // Create experiment record
    const expName = name ?? `${programName} — ${dayName} ${timeStr}`;
    const { data: exp, error: expErr } = await supabase
      .from("outreach_experiments")
      .insert({
        club_id:           clubId,
        name:              expName,
        event_id:          eventId,
        event_name:        (dec as any).event_name,
        event_start:       eventStartIso,
        decision_id:       decisionId,
        status:            "ready",
        treatment_pct:     treatmentPct,
        randomized_at:     new Date().toISOString(),
        randomization_seed: String(bestSeed),
        pool_size:         poolSize,
        notes:             notes ?? null,
      })
      .select()
      .single();
    if (expErr) throw new Error(expErr.message);

    // Build participant rows
    const participantRows: any[] = [];

    for (const [idx, c] of treatmentCands.entries()) {
      const msg = draftMessage({
        playerName:  c.player_name,
        segment:     c.segment as "lapsing" | "recent_dormant",
        daysSince:   c.days_since,
        buddyCount:  c.buddy_count,
        dayName, timeStr,
        sessionName: programName,
        bookingLink,
      });
      participantRows.push({
        experiment_id: exp.id,
        player_id:     c.player_id,
        arm:           "treatment",
        rank:          idx + 1,
        score:         c.score,
        reasons:       c.reasons,
        message_text:  msg,
        channel:       "sms",
      });
    }

    for (const [idx, c] of controlCands.entries()) {
      participantRows.push({
        experiment_id: exp.id,
        player_id:     c.player_id,
        arm:           "control",
        rank:          idx + 1,
        score:         c.score,
        reasons:       c.reasons,
        message_text:  null,
        channel:       "sms",
      });
    }

    // Insert participants in batches
    for (let i = 0; i < participantRows.length; i += 100) {
      const { error: pErr } = await supabase.from("experiment_participants")
        .insert(participantRows.slice(i, i + 100));
      if (pErr) throw new Error(`participant insert: ${pErr.message}`);
    }

    res.status(201).json({
      experiment:       exp,
      pool_size:        poolSize,
      n_treatment:      nTreatment,
      n_control:        nControl,
      reseeds,
      balance:          bestBalance,
      treatment_stats:  armStats(treatmentCands),
      control_stats:    armStats(controlCands),
      funnel,
    });
  } catch (err: any) {
    logger.error({ err }, "[experiments/create] error");
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/experiments ─────────────────────────────────────────────────────

router.get("/experiments", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  try {
    const { data, error } = await supabase
      .from("outreach_experiments")
      .select("id, name, event_name, event_start, status, treatment_pct, pool_size, randomized_at, sent_at, notes, created_at")
      .eq("club_id", clubId)
      .order("created_at", { ascending: false });
    // PGRST205 / "schema cache" = table not yet created (migration 007 pending) — return empty
    if (error) {
      if (error.message?.includes("schema cache") || (error as any).code === "PGRST205") {
        res.json({ experiments: [], migration_pending: true }); return;
      }
      res.status(500).json({ error: error.message }); return;
    }

    // Augment with participant counts
    const ids = (data ?? []).map((e: any) => e.id);
    let counts: Record<string, { treatment: number; control: number; sent: number; vetoed: number }> = {};
    if (ids.length > 0) {
      const { data: parts } = await supabase
        .from("experiment_participants")
        .select("experiment_id, arm, vetoed, sent_at")
        .in("experiment_id", ids);
      for (const p of (parts ?? [])) {
        const c = counts[p.experiment_id] ?? { treatment: 0, control: 0, sent: 0, vetoed: 0 };
        if ((p as any).arm === "treatment") c.treatment++;
        else c.control++;
        if ((p as any).sent_at) c.sent++;
        if ((p as any).vetoed) c.vetoed++;
        counts[p.experiment_id] = c;
      }
    }

    res.json({
      experiments: (data ?? []).map((e: any) => ({
        ...e,
        counts: counts[e.id] ?? { treatment: 0, control: 0, sent: 0, vetoed: 0 },
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/experiments/:id ─────────────────────────────────────────────────

// ─── GET /api/experiments/pooled-results ─────────────────────────────────────
// Aggregate results across all completed experiments for this club.
// NOTE: must be registered BEFORE /experiments/:id or Express matches
// "pooled-results" as an :id (pre-existing routing bug, fixed here).

router.get("/experiments/pooled-results", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  try {
    const { data: exps } = await supabase.from("outreach_experiments")
      .select("id, name, event_name, event_start, status, sent_at")
      .eq("club_id", clubId)
      .in("status", ["measuring", "complete"])
      .order("event_start", { ascending: false });

    if (!exps || exps.length === 0) { res.json({ experiments: [], pooled: null }); return; }

    const { data: rawPooledParts } = await supabase.from("experiment_participants")
      .select("experiment_id, arm, vetoed, booked_target_session, attended_within_30d, reasons")
      .in("experiment_id", exps.map((e: any) => e.id))
      .eq("vetoed", false);
    // Simulated dispatches delivered nothing — exclude from pooled aggregation
    // (same rule as outcome measurement).
    const parts = (rawPooledParts ?? []).filter(
      (p: any) => !(p.reasons?.dispatch_simulated === true) && !(p.reasons?.dispatch_failed === true));

    // Per-experiment
    const byExp: Record<string, any> = {};
    for (const e of exps) {
      byExp[e.id] = { experiment: e, treatment: [], control: [] };
    }
    for (const p of (parts ?? [])) {
      const ex = byExp[(p as any).experiment_id];
      if (!ex) continue;
      if ((p as any).arm === "treatment") ex.treatment.push(p);
      else ex.control.push(p);
    }

    const experiments = Object.values(byExp).map(({ experiment: e, treatment, control }: any) => ({
      id: e.id, name: e.name, event_name: e.event_name, event_start: e.event_start, status: e.status,
      treatment: {
        n: treatment.length,
        booked:   treatment.filter((p: any) => p.booked_target_session === true).length,
        attended: treatment.filter((p: any) => p.attended_within_30d === true).length,
        provisional_30d: treatment.some((p: any) => p.attended_within_30d === null),
      },
      control: {
        n: control.length,
        booked:   control.filter((p: any) => p.booked_target_session === true).length,
        attended: control.filter((p: any) => p.attended_within_30d === true).length,
        provisional_30d: control.some((p: any) => p.attended_within_30d === null),
      },
    }));

    // Pooled across all experiments
    const allTreatment = experiments.flatMap(e => Array(e.treatment.n).fill(null).map((_, i) => ({
      booked: i < e.treatment.booked, attended: i < e.treatment.attended
    })));
    const allControl = experiments.flatMap(e => Array(e.control.n).fill(null).map((_, i) => ({
      booked: i < e.control.booked, attended: i < e.control.attended
    })));

    const pooled = {
      n_experiments:        experiments.length,
      treatment_n:          allTreatment.length,
      control_n:            allControl.length,
      treatment_booked:     allTreatment.filter(p => p.booked).length,
      control_booked:       allControl.filter(p => p.booked).length,
      treatment_attended:   allTreatment.filter(p => p.attended).length,
      control_attended:     allControl.filter(p => p.attended).length,
      power_caveat: "With fewer than 100 participants per arm, this pooled result can detect a large effect or a zero effect. It cannot distinguish a modest positive effect from chance. Treat these numbers as a directional read only.",
    };

    res.json({ experiments, pooled });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/experiments/:id", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { id } = req.params;
  try {
    const { data: exp, error: expErr } = await supabase
      .from("outreach_experiments")
      .select("*")
      .eq("id", id).eq("club_id", clubId)
      .maybeSingle();
    if (expErr) {
      if (expErr.message?.includes("schema cache") || (expErr as any).code === "PGRST205") {
        res.status(503).json({ error: "Migration 007 not yet applied — paste 007_experiments.sql into Supabase SQL editor to enable experiments." }); return;
      }
      res.status(500).json({ error: expErr.message }); return;
    }
    if (!exp)   { res.status(404).json({ error: "Experiment not found" }); return; }

    const { data: participants } = await supabase
      .from("experiment_participants")
      .select("*, players(name, phone, sms_opt_in, last_visit_date, attendance_archetype)")
      .eq("experiment_id", id)
      .order("arm").order("rank");

    res.json({ experiment: exp, participants: participants ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/experiments/:id/veto/:pid ──────────────────────────────────────

router.post("/experiments/:id/veto/:pid", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { id, pid } = req.params;
  const { reason } = req.body ?? {};

  try {
    // Verify experiment belongs to club and is still modifiable
    const { data: exp } = await supabase.from("outreach_experiments")
      .select("id, status").eq("id", id).eq("club_id", clubId).maybeSingle();
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }
    if (exp.status === "complete") { res.status(409).json({ error: "Cannot veto in a completed experiment" }); return; }

    const { error } = await supabase.from("experiment_participants")
      .update({ vetoed: true, veto_reason: reason ?? null })
      .eq("id", pid).eq("experiment_id", id);
    if (error) { res.status(500).json({ error: error.message }); return; }

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/experiments/:id/participants/:pid ─────────────────────────────

router.patch("/experiments/:id/participants/:pid", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { id, pid } = req.params;
  const { message_text } = req.body ?? {};

  try {
    const { data: exp } = await supabase.from("outreach_experiments")
      .select("id, status").eq("id", id).eq("club_id", clubId).maybeSingle();
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }
    if (exp.status === "complete") { res.status(409).json({ error: "Cannot edit in a completed experiment" }); return; }

    const { error } = await supabase.from("experiment_participants")
      .update({ message_text: message_text ?? null })
      .eq("id", pid).eq("experiment_id", id).eq("arm", "treatment");
    if (error) { res.status(500).json({ error: error.message }); return; }

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/experiments/:id/mark-sent ──────────────────────────────────────
// Marks participants as sent (operator confirms manual send).
// Writes contact_ledger rows. Does NOT send any messages.

router.post("/experiments/:id/mark-sent", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { id } = req.params;
  const { participantIds }: { participantIds: string[] } = req.body ?? {};
  if (!Array.isArray(participantIds) || participantIds.length === 0) {
    res.status(400).json({ error: "participantIds (array) required" }); return;
  }

  try {
    const { data: exp } = await supabase.from("outreach_experiments")
      .select("id, status, event_id").eq("id", id).eq("club_id", clubId).maybeSingle();
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }
    if (exp.status === "complete") { res.status(409).json({ error: "Experiment is already complete" }); return; }

    // ── Level-gate recheck — a manual send to a level-gated event is still an
    // invalid invitation; block it just like automated dispatch. Fails closed.
    if ((exp as any).event_id) {
      const { data: gateClub } = await supabase.from("clubs")
        .select("platform_subdomain, platform_api_key").eq("id", clubId).maybeSingle();
      if (!gateClub?.platform_subdomain) {
        res.status(503).json({ error: "Club not configured — cannot verify event level gate. Mark-sent blocked." }); return;
      }
      const gate = await checkEventLevelGate(
        `https://${gateClub.platform_subdomain}.podplay.app/apis/v2`,
        (gateClub as any).platform_api_key ?? process.env.PODPLAY_API_KEY ?? "",
        (exp as any).event_id,
      );
      if (gate.fetchError) {
        res.status(503).json({ error: `Cannot verify event level gate (${gate.fetchError}). Mark-sent blocked — retry when PodPlay is reachable.` }); return;
      }
      if (gate.gated) {
        res.status(422).json({ error: levelGateMessage(gate.min, gate.max), level_gated: true }); return;
      }
    }

    // Only treatment participants can be marked sent
    const { data: parts } = await supabase.from("experiment_participants")
      .select("id, player_id, arm, vetoed")
      .in("id", participantIds).eq("experiment_id", id);

    const now = new Date().toISOString();
    const toMark = (parts ?? []).filter((p: any) => p.arm === "treatment" && !p.vetoed);
    if (toMark.length === 0) {
      res.status(422).json({ error: "No eligible treatment participants in that list" }); return;
    }

    // Mark sent_at on participants
    const { error: markErr } = await supabase.from("experiment_participants")
      .update({ sent_at: now }).in("id", toMark.map((p: any) => p.id));
    if (markErr) { res.status(500).json({ error: markErr.message }); return; }

    // Write contact_ledger rows (one per participant).
    // mark-sent = operator confirms a REAL manual send, so ledger rows are correct here.
    const ledgerRows = toMark.map((p: any) => ({
      club_id:       clubId,
      player_id:     p.player_id,
      experiment_id: id,
      source:        "experiment",
      channel:       "sms",
      purpose:       "promotion",
      sent_at:       now,
    }));
    for (let i = 0; i < ledgerRows.length; i += 100) {
      const { error: ledgerErr } = await supabase.from("contact_ledger").insert(ledgerRows.slice(i, i + 100));
      if (ledgerErr) {
        logger.error({ err: ledgerErr.message, experiment_id: id },
          "[experiments/mark-sent] contact_ledger insert FAILED — budget gate will not see these sends");
      }
    }

    // Update experiment status to 'sent' if not already
    if (exp.status === "ready") {
      await supabase.from("outreach_experiments")
        .update({ status: "sent", sent_at: now }).eq("id", id);
    }

    res.json({ ok: true, marked: toMark.length });
  } catch (err: any) {
    logger.error({ err }, "[experiments/mark-sent] error");
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/experiments/:id/measure ───────────────────────────────────────
// Runs outcome measurement for one experiment.
// Safe to re-run — idempotent.

const measurementJobs = new Map<string, { status: "running" | "done" | "error"; result?: any; error?: string; startedAt: string }>();

router.post("/experiments/:id/measure", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { id } = req.params;

  const existing = measurementJobs.get(id);
  if (existing?.status === "running") {
    res.status(409).json({ error: "Measurement already running", statusUrl: `/api/experiments/${id}/measure/status` }); return;
  }

  try {
    const { data: exp } = await supabase.from("outreach_experiments")
      .select("*").eq("id", id).eq("club_id", clubId).maybeSingle();
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }

    measurementJobs.set(id, { status: "running", startedAt: new Date().toISOString() });

    res.status(202).json({ message: "Measurement started", statusUrl: `/api/experiments/${id}/measure/status` });

    // Run async — do not await
    (async () => {
      try {
        const { data: rawParts } = await supabase.from("experiment_participants")
          .select("id, player_id, arm, sent_at, vetoed, reasons")
          .eq("experiment_id", id).eq("vetoed", false);
        // Exclude simulated participants (nothing was delivered) and failed
        // dispatches (message never arrived) — neither carries treatment signal.
        const parts = (rawParts ?? []).filter(
          (p: any) => !(p.reasons?.dispatch_simulated === true) && !(p.reasons?.dispatch_failed === true));

        const now = new Date();
        const nowIso = now.toISOString();
        const eventStart = new Date((exp as any).event_start);

        // Attendances lookup: keyed by player_id → sorted list of attended_at dates
        const playerIds = (parts ?? []).map((p: any) => p.player_id);
        const attendanceMap = new Map<string, Date[]>();
        if (playerIds.length > 0) {
          for (let ci = 0; ci < playerIds.length; ci += 100) {
            const { data: atts } = await supabase.from("attendances")
              .select("player_id, attended_at, event_id")
              .in("player_id", playerIds.slice(ci, ci + 100))
              .gte("attended_at", (exp as any).randomized_at);
            for (const a of (atts ?? [])) {
              if (!attendanceMap.has(a.player_id)) attendanceMap.set(a.player_id, []);
              attendanceMap.get(a.player_id)!.push({ date: new Date(a.attended_at), eventId: a.event_id } as any);
            }
          }
        }

        const eventPassed = now > eventStart;

        let nMeasured = 0;
        for (const p of (parts ?? [])) {
          const windowStart = new Date((p as any).sent_at ?? (exp as any).randomized_at);
          const windowEnd   = new Date(windowStart.getTime() + 30 * 86_400_000);
          const windowFinal = windowEnd < now; // 30d window has closed

          const atts = attendanceMap.get((p as any).player_id) ?? [];
          // booked_target_session: only final once event has passed
          const bookedTarget = eventPassed
            ? atts.some((a: any) => a.eventId === (exp as any).event_id)
            : null; // still provisional
          // attended_within_30d: only final once window has closed
          const attended30d = windowFinal
            ? atts.some((a: any) => a.date >= windowStart && a.date <= windowEnd)
            : null;
          const firstAtt = atts.filter((a: any) => a.date >= windowStart).sort((x: any, y: any) => x.date - y.date)[0];

          const update: any = { outcome_measured_at: nowIso };
          if (bookedTarget !== null) update.booked_target_session = bookedTarget;
          if (attended30d  !== null) update.attended_within_30d = attended30d;
          if (firstAtt)              update.first_attendance_at = (firstAtt as any).date.toISOString();

          await supabase.from("experiment_participants").update(update).eq("id", (p as any).id);
          nMeasured++;
        }

        // Update experiment status — simulated participants excluded from the
        // completeness rollup too (they are never measured, so they'd hold the
        // experiment in "measuring" forever otherwise).
        const { data: updatedRaw } = await supabase.from("experiment_participants")
          .select("attended_within_30d, booked_target_session, reasons")
          .eq("experiment_id", id).eq("vetoed", false);
        const updatedParts = (updatedRaw ?? []).filter(
          (p: any) => !(p.reasons?.dispatch_simulated === true) && !(p.reasons?.dispatch_failed === true));

        const allHave30d = (updatedParts ?? []).every((p: any) =>
          (p as any).attended_within_30d !== null);
        if (allHave30d && eventPassed) {
          await supabase.from("outreach_experiments").update({ status: "complete" }).eq("id", id);
        } else if (eventPassed) {
          await supabase.from("outreach_experiments").update({ status: "measuring" }).eq("id", id);
        }

        measurementJobs.set(id, { status: "done", result: { n_measured: nMeasured, event_passed: eventPassed }, startedAt: measurementJobs.get(id)!.startedAt });
      } catch (err: any) {
        logger.error({ err, experiment_id: id }, "[experiments/measure] measurement job failed");
        measurementJobs.set(id, { status: "error", error: err.message, startedAt: measurementJobs.get(id)!.startedAt });
      }
    })();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/experiments/:id/measure/status ─────────────────────────────────

router.get("/experiments/:id/measure/status", requireClub, async (req, res) => {
  const { id } = req.params;
  const job = measurementJobs.get(id);
  if (!job) { res.json({ status: "idle" }); return; }
  res.json(job);
});

// ─── POST /api/experiments/:id/send ──────────────────────────────────────────
// Dispatches treatment arm via Twilio — or previews without dispatching if dryRun: true.
//
// Hard constraints enforced here:
//   - No PodPlay writes.
//   - No automatic or scheduled dispatch — only fires on an explicit approved: true request.
//   - Writes only to: messages, contact_ledger, experiment_participants.
//   - Phone numbers never echoed in response. Twilio SIDs masked.

const DISPATCH_HARD_CAP = 50; // code-level, not tunable from rules

router.post("/experiments/:id/send", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { id }  = req.params;
  const { approved = false, dryRun = false } = req.body ?? {};

  // Explicit approval required for live dispatch
  if (!dryRun && !approved) {
    res.status(400).json({
      error: "approved: true is required to dispatch. Use dryRun: true for a safe preview.",
    });
    return;
  }

  try {
    // ── Load experiment ───────────────────────────────────────────────────────
    const { data: exp, error: expErr } = await supabase
      .from("outreach_experiments")
      .select("id, name, status, event_id, event_name, event_start, decision_id, pool_size, treatment_pct")
      .eq("id", id).eq("club_id", clubId).maybeSingle();
    if (expErr?.message?.includes("schema cache")) {
      res.status(503).json({ error: "Migration 007 not yet applied." }); return;
    }
    if (!exp) { res.status(404).json({ error: "Experiment not found" }); return; }
    if (!dryRun && exp.status !== "ready") {
      res.status(409).json({
        error: `Experiment is '${exp.status}' — only 'ready' experiments can be dispatched. Already-sent experiments cannot be re-dispatched.`,
      }); return;
    }

    // ── Level-gate recheck — covers experiments created before the gate rule ──
    if (!dryRun && (exp as any).event_id) {
      const { data: gateClub } = await supabase.from("clubs")
        .select("platform_subdomain, platform_api_key").eq("id", clubId).maybeSingle();
      if (!gateClub?.platform_subdomain) {
        res.status(503).json({ error: "Club not configured — cannot verify event level gate. Dispatch blocked." }); return;
      }
      const gate = await checkEventLevelGate(
        `https://${gateClub.platform_subdomain}.podplay.app/apis/v2`,
        (gateClub as any).platform_api_key ?? process.env.PODPLAY_API_KEY ?? "",
        (exp as any).event_id,
      );
      if (gate.fetchError) {
        res.status(503).json({ error: `Cannot verify event level gate (${gate.fetchError}). Dispatch blocked — retry when PodPlay is reachable.` }); return;
      }
      if (gate.gated) {
        res.status(422).json({ error: levelGateMessage(gate.min, gate.max), level_gated: true }); return;
      }
    }

    // ── Kill switch (3d) — check once at batch start; also checked per-message ──
    const overrideTo  = (process.env.SMS_TEST_OVERRIDE_TO ?? "").trim();
    const smsLive     = process.env.SMS_LIVE === "true";
    const killRow     = await supabase.from("clubs").select("sms_kill_switch, name").eq("id", clubId).maybeSingle();
    const killSwitch  = !!(killRow.data as any)?.sms_kill_switch;
    if (!dryRun && killSwitch) {
      res.status(503).json({
        error: "SMS kill switch is engaged. Set clubs.sms_kill_switch = false to resume.",
      }); return;
    }

    // ── Load treatment participants ────────────────────────────────────────────
    const { data: parts } = await supabase
      .from("experiment_participants")
      .select("id, player_id, arm, vetoed, sent_at, message_text, score, rank, reasons")
      .eq("experiment_id", id)
      .eq("arm", "treatment")
      .eq("vetoed", false)
      .is("sent_at", null)
      .order("rank", { ascending: true });

    const eligible = parts ?? [];

    // ── 3c: Control-arm exclusion — belt-and-suspenders at send time ──────────
    const controlLeak = eligible.filter((p: any) => p.arm !== "treatment");
    if (controlLeak.length > 0) {
      res.status(422).json({ error: "Control arm members detected in dispatch list — aborting. This should never happen." }); return;
    }

    // ── 3a: Hard batch cap ────────────────────────────────────────────────────
    if (eligible.length > DISPATCH_HARD_CAP) {
      res.status(422).json({
        error: `Batch size ${eligible.length} exceeds hard cap of ${DISPATCH_HARD_CAP}. Dispatch aborted.`,
      }); return;
    }

    // ── 3e: Consent re-check ──────────────────────────────────────────────────
    const playerIds = eligible.map((p: any) => p.player_id);
    const { data: players } = await supabase.from("players")
      .select("id, name, phone, sms_opt_in").in("id", playerIds);
    const playerMap = new Map((players ?? []).map((p: any) => [p.id, p]));

    const unconsented = eligible.filter((p: any) => {
      const pl = playerMap.get(p.player_id);
      return !pl || !pl.sms_opt_in || !pl.phone;
    });
    if (unconsented.length > 0) {
      res.status(422).json({
        error: `${unconsented.length} recipient(s) lost consent or have no phone since list was built. Resolve before dispatching.`,
        unconsented_participant_ids: unconsented.map((p: any) => p.id),
      }); return;
    }

    // ── 3f: Dry-run — return full preview without dispatching ─────────────────
    if (dryRun) {
      const preconditions = {
        experiment_ready: exp.status === "ready",
        kill_switch_off: !killSwitch,
        within_hard_cap: eligible.length <= DISPATCH_HARD_CAP,
        all_consented:   unconsented.length === 0,
        no_control_leak: controlLeak.length === 0,
        sms_live:        smsLive,
        test_override_active: !!overrideTo,
      };
      const allGreen = preconditions.experiment_ready
        && preconditions.kill_switch_off
        && preconditions.within_hard_cap
        && preconditions.all_consented
        && preconditions.no_control_leak;

      return res.json({
        dry_run:    true,
        all_green:  allGreen,
        sms_live:   smsLive,
        test_override_active:   !!overrideTo,
        test_override_to_masked: overrideTo ? `${overrideTo.slice(0, 5)}•••${overrideTo.slice(-4)}` : null,
        would_send: eligible.length,
        preconditions,
        recipients: eligible.map((p: any) => {
          const pl = playerMap.get(p.player_id);
          return {
            participant_id:  p.id,
            player_name:     pl?.name ?? "Unknown",
            rank:            p.rank,
            score:           p.score,
            segment:         p.reasons?.retention_segment ?? "—",
            message_preview: (p.message_text ?? "").slice(0, 120) + ((p.message_text ?? "").length > 120 ? "…" : ""),
            sms_reachable:   !!pl?.sms_opt_in && !!pl?.phone,
          };
        }),
      });
    }

    // ── Fault injection (development only) — used by Phase 4.3 induced-failure
    // verification. Header format: "twilio:<pid>;ledger:<pid>;update:<pid>".
    // Ignored entirely when NODE_ENV === "production".
    const faultHeader = (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test")
      ? String(req.headers["x-fault-inject"] ?? "") : "";
    const faults = new Map<string, string>(); // participant_id → fault kind
    for (const spec of faultHeader.split(";").filter(Boolean)) {
      const [kind, pid] = spec.split(":");
      if (kind && pid) faults.set(pid.trim(), kind.trim());
    }
    if (faults.size > 0) logger.warn({ faults: [...faults.entries()] }, "[experiments/send] FAULT INJECTION ACTIVE (dev only)");

    // ─── LIVE DISPATCH ────────────────────────────────────────────────────────
    logger.info({ experiment_id: id, batch_size: eligible.length, test_override: !!overrideTo }, "[experiments/send] dispatch started");

    const results: any[] = [];
    let sentCount = 0, failedCount = 0, skippedCount = 0, abortedCount = 0;
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
    let killSwitchHit = false;

    for (const part of eligible) {
      if (killSwitchHit) {
        results.push({ participant_id: part.id, outcome: "aborted", reason: "kill_switch_mid_batch" });
        abortedCount++;
        continue;
      }

      // ── Per-recipient: re-check kill switch ───────────────────────────────
      const { data: ks } = await supabase.from("clubs").select("sms_kill_switch").eq("id", clubId).maybeSingle();
      if ((ks as any)?.sms_kill_switch) {
        killSwitchHit = true;
        logger.warn({ experiment_id: id, participant_id: part.id }, "[experiments/send] kill switch engaged mid-batch — stopping");
        results.push({ participant_id: part.id, outcome: "aborted", reason: "kill_switch_engaged" });
        abortedCount++;
        continue;
      }

      // ── Per-recipient: re-check sent_at IS NULL (idempotency guard) ────────
      const { data: freshPart } = await supabase
        .from("experiment_participants")
        .select("sent_at, vetoed, reasons").eq("id", part.id).maybeSingle();
      if (!freshPart || freshPart.sent_at || freshPart.vetoed) {
        results.push({ participant_id: part.id, outcome: "skipped", reason: "already_sent_or_vetoed" });
        skippedCount++;
        continue;
      }

      // ── Per-recipient: re-check consent ───────────────────────────────────
      const { data: freshPlayer } = await supabase
        .from("players").select("id, name, phone, sms_opt_in").eq("id", part.player_id).maybeSingle();
      if (!freshPlayer?.sms_opt_in || !freshPlayer?.phone) {
        results.push({ participant_id: part.id, outcome: "skipped", reason: "not_consented_or_no_phone" });
        skippedCount++;
        continue;
      }

      const messageBody = part.message_text ?? "";
      const sentAt      = new Date().toISOString();

      try {
        if (faults.get(part.id) === "twilio") {
          throw new Error("FAULT_INJECT: simulated Twilio API error (dev-only test)");
        }
        // sendViaTwilio handles SMS_TEST_OVERRIDE_TO and SMS_LIVE gate
        const { sid, simulated } = await sendViaTwilio(freshPlayer.phone, messageBody);

        // Write messages row — insert before any other state mutation
        const { data: msgRow, error: msgErr } = await supabase.from("messages").insert({
          player_id:         part.player_id,
          body:              messageBody,
          direction:         "outbound",
          sent_by:           "operator",
          status:            "sent",
          twilio_message_sid: sid,
          simulated,
          sent_at:           sentAt,
        }).select("id").maybeSingle();
        if (msgErr) {
          // Loud, not fatal — the send already happened. The sid in this log
          // line is the only remaining record of it if the insert failed.
          logger.error({ err: msgErr.message, participant_id: part.id, experiment_id: id, twilio_sid: sid },
            "[experiments/send] messages insert FAILED — send happened but has no messages row");
        }

        // Write contact_ledger row — REAL sends only. A simulated dispatch
        // (SMS_LIVE=false) delivered nothing; writing a ledger row would put
        // the player under a cooldown for a message they never received.
        if (!simulated || faults.get(part.id) === "ledger") {
          const { error: ledgerErr } = await supabase.from("contact_ledger").insert({
            club_id:       clubId,
            player_id:     part.player_id,
            experiment_id: id,
            source:        "experiment",
            channel:       "sms",
            purpose:       "promotion",
            sent_at:       sentAt,
            // dev-only fault: nonexistent column forces a real insert error
            ...(faults.get(part.id) === "ledger" ? { fault_inject_nonexistent_col: true } : {}),
          } as any);
          if (ledgerErr) {
            // Loud, not fatal — the send already happened; but a silent ledger
            // failure breaks the contact budget gate for this player.
            logger.error({ err: ledgerErr.message, participant_id: part.id, experiment_id: id },
              "[experiments/send] contact_ledger insert FAILED — budget gate will not see this send");
          }
        }

        // Mark participant sent + record simulation state on the row so
        // simulated dispatches are distinguishable from real ones.
        // A successful send clears any dispatch_failed flag from a prior attempt.
        const successReasons: any = { ...((freshPart as any).reasons ?? {}), dispatch_simulated: simulated };
        delete successReasons.dispatch_failed;
        const { error: partUpdErr } = await supabase.from("experiment_participants")
          .update({
            sent_at: sentAt, reasons: successReasons,
            // dev-only fault: nonexistent column forces a real update error (retry below uses the clean payload)
            ...(faults.get(part.id) === "update" ? { fault_inject_nonexistent_col: true } : {}),
          } as any).eq("id", part.id);

        const maskedSid = `${sid.slice(0, 6)}...${sid.slice(-4)}`;
        if (partUpdErr) {
          // WORST CASE: the send happened but sent_at was not recorded — the
          // participant would be re-dispatched (double send) on the next run.
          // Retry once; if it still fails, surface loudly and report a distinct
          // outcome so the operator does NOT re-dispatch blindly.
          const { error: retryErr } = await supabase.from("experiment_participants")
            .update({ sent_at: sentAt, reasons: successReasons }).eq("id", part.id);
          if (retryErr) {
            logger.error({ err: retryErr.message, participant_id: part.id, experiment_id: id, twilio_sid: sid },
              "[experiments/send] participant update FAILED after send — sent_at NOT recorded; participant WOULD BE RE-DISPATCHED. Fix the row before dispatching again.");
            results.push({ participant_id: part.id, outcome: "sent_unrecorded", twilio_sid: maskedSid, simulated, error: retryErr.message });
            sentCount++;
            await delay(100);
            continue;
          }
        }

        results.push({
          participant_id: part.id,
          outcome:        "sent",
          twilio_sid:     maskedSid,
          simulated,
          message_id:     msgRow?.id ?? null,
        });
        sentCount++;
      } catch (err: any) {
        logger.error({ err, participant_id: part.id, experiment_id: id }, "[experiments/send] Twilio error");
        // Mark the participant as failed: NOT sent (no sent_at), flagged so
        // outcome measurement excludes them — a participant whose message
        // failed is not a valid treatment subject.
        const failReasons: any = { ...((freshPart as any).reasons ?? {}), dispatch_failed: true };
        const { error: failUpdErr } = await supabase.from("experiment_participants")
          .update({
            veto_reason: `dispatch_error: ${err.message?.slice(0, 200) ?? "unknown"}`,
            reasons: failReasons,
          }).eq("id", part.id);
        if (failUpdErr) {
          logger.error({ err: failUpdErr.message, participant_id: part.id, experiment_id: id },
            "[experiments/send] could not record dispatch failure on participant row");
        }
        results.push({ participant_id: part.id, outcome: "failed", error: err.message });
        failedCount++;
        // Do NOT abort remaining — partial failure must not corrupt state
      }

      // Rate limit: ~10 msg/s (matches existing bulk path)
      await delay(100);
    }

    // Update experiment status to 'sent' if any sent
    if (sentCount > 0) {
      await supabase.from("outreach_experiments")
        .update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", id);
    }

    logger.info({ experiment_id: id, sentCount, failedCount, skippedCount, abortedCount }, "[experiments/send] dispatch complete");

    res.json({
      dispatched:           sentCount,
      failed:               failedCount,
      skipped:              skippedCount,
      aborted:              abortedCount,
      test_override_active: !!overrideTo,
      sms_live:             smsLive,
      results,
    });

  } catch (err: any) {
    logger.error({ err }, "[experiments/send] error");
    res.status(500).json({ error: err.message });
  }
});

export default router;

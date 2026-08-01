/**
 * programmingEvaluator — shadow evaluator for the programming agent.
 *
 * Phase 2 implementation: evaluate-only, no PodPlay writes, no SMS.
 * Decisions are written to programming_decisions with executed=false.
 *
 * Idempotency: the UNIQUE(event_id, checkpoint_index) constraint on
 * programming_decisions guarantees re-runs never produce duplicate rows.
 * On conflict the row is left unchanged (the first evaluation wins).
 *
 * Evaluation flow per event:
 *   1. Load active rules for the club (enabled=true, mode='shadow').
 *   2. For each rule, check match_rules against the event.
 *   3. For each matching rule, find the highest-index checkpoint whose
 *      offset_hours >= hoursUntilStart (i.e., the trigger window has opened).
 *   4. If no decision row exists for (event_id, checkpoint.index), fetch the
 *      active signup count from PodPlay and write a decision row.
 *   5. Compare the agent decision against the native PodPlay rule config.
 */

import { supabase } from "./supabaseClient";
import { loadArchetypes, classifyEvent } from "./classifyEvent";
import { logger } from "./logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RuleCheckpoint {
  index: number;
  offset_hours: number;
  min_signups: number;
  action: "CANCEL" | "ALERT";
}

export interface ProgrammingRule {
  id: string;
  club_id: string;
  name: string;
  enabled: boolean;
  match_rules: {
    archetype_ids?: string[];
    keywords?: string[];
    podplay_types?: string[];
  };
  checkpoints: RuleCheckpoint[];
  mode: "shadow" | "live";
}

interface UpcomingEvent {
  id: string;
  name: string;
  customType?: string;
  tags?: string[];
  startTime: string;
  totalTeams?: number;
  lowTurnoutAutoCancelAttendeeCount?: number;
  lowTurnoutAutoCancelHoursBefore?: number;
}

export interface EvaluatorStats {
  events_fetched: number;
  events_evaluated: number;
  decisions_written: number;
  decisions_skipped_existing: number;
  errors: number;
}

const INACTIVE_STATUSES = new Set(["CANCELED", "INVALID", "DRAFT"]);
const LOOKAHEAD_HOURS = 96; // evaluate events starting within 96 hours

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchClubConfig(clubId: string) {
  const { data, error } = await supabase
    .from("clubs")
    .select("platform_api_key, platform_subdomain")
    .eq("id", clubId)
    .maybeSingle();
  if (error) throw new Error(`fetchClubConfig: ${error.message}`);
  if (!data?.platform_subdomain)
    throw new Error(`Club ${clubId} has no platform_subdomain`);
  return {
    apiKey: data.platform_api_key ?? process.env.PODPLAY_API_KEY ?? "",
    apiBase: `https://${data.platform_subdomain}.podplay.app/apis/v2`,
  };
}

/** Fetch upcoming events from PodPlay (next LOOKAHEAD_HOURS). */
async function fetchUpcomingEvents(
  apiBase: string,
  apiKey: string,
): Promise<UpcomingEvent[]> {
  const now = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_HOURS * 3_600_000);
  const url =
    `${apiBase}/events?pageSize=100&page=1` +
    `&startTimeFrom=${encodeURIComponent(now.toISOString())}` +
    `&startTimeTo=${encodeURIComponent(horizon.toISOString())}`;

  const res = await fetch(url, { headers: { "x-api-key": apiKey } });
  if (!res.ok)
    throw new Error(`fetchUpcomingEvents: ${res.status} ${await res.text()}`);
  const body: any = await res.json();
  const items: UpcomingEvent[] = body?.items ?? [];
  // Client-side guard: PodPlay startTimeTo is not strictly UTC-enforced
  return items.filter(
    (e) => e.startTime && new Date(e.startTime) > now,
  );
}

/** Fetch active signup count for one event (excludes CANCELED/INVALID/DRAFT). */
export async function fetchActiveSignupCount(
  apiBase: string,
  apiKey: string,
  eventId: string,
): Promise<number> {
  let active = 0;
  let page = 1;
  while (true) {
    const res = await fetch(
      `${apiBase}/events/${eventId}/signups?pageSize=200&page=${page}`,
      { headers: { "x-api-key": apiKey } },
    );
    if (!res.ok) break;
    const body: any = await res.json();
    const items: any[] = body?.items ?? [];
    active += items.filter((s) => !INACTIVE_STATUSES.has(s.status)).length;
    if (items.length < 200) break;
    page++;
    await sleep(100);
  }
  return active;
}

/** Load all enabled rules for a club. */
async function loadRules(clubId: string): Promise<ProgrammingRule[]> {
  const { data, error } = await supabase
    .from("programming_rules")
    .select("id, club_id, name, enabled, match_rules, checkpoints, mode")
    .eq("club_id", clubId)
    .eq("enabled", true);
  if (error) throw new Error(`loadRules: ${error.message}`);
  return (data ?? []) as ProgrammingRule[];
}

/** Load already-evaluated (event_id, checkpoint_index) pairs. */
async function loadExistingDecisionKeys(
  clubId: string,
  eventIds: string[],
): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from("programming_decisions")
    .select("event_id, checkpoint_index")
    .eq("club_id", clubId)
    .in("event_id", eventIds);
  if (error) throw new Error(`loadExistingDecisionKeys: ${error.message}`);
  const keys = new Set<string>();
  for (const row of data ?? []) {
    keys.add(`${(row as any).event_id}::${(row as any).checkpoint_index}`);
  }
  return keys;
}

/** Match an event against a rule's match_rules. Returns true if the rule applies. */
function matchRule(
  event: UpcomingEvent,
  archetypeId: string | null,
  rule: ProgrammingRule,
): boolean {
  const mr = rule.match_rules;

  // archetype_ids filter (if set)
  if (mr.archetype_ids?.length) {
    if (!archetypeId || !mr.archetype_ids.includes(archetypeId)) return false;
  }

  // keywords filter (if set) — ANY keyword must appear in event name
  if (mr.keywords?.length) {
    const name = (event.name ?? "").toLowerCase();
    if (!mr.keywords.some((kw) => name.includes(kw.toLowerCase()))) return false;
  }

  // podplay_types filter (if set)
  if (mr.podplay_types?.length) {
    if (!event.customType || !mr.podplay_types.includes(event.customType)) return false;
  }

  return true;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runEvaluator(
  clubId: string,
  log: (msg: string) => void,
  opts: { dryRun?: boolean; sleepMs?: number } = {},
): Promise<EvaluatorStats> {
  const { dryRun = false, sleepMs = 300 } = opts;
  const stats: EvaluatorStats = {
    events_fetched: 0,
    events_evaluated: 0,
    decisions_written: 0,
    decisions_skipped_existing: 0,
    errors: 0,
  };

  log(`[evaluator] clubId=${clubId} dryRun=${dryRun}`);

  const { apiKey, apiBase } = await fetchClubConfig(clubId);
  const archetypes = await loadArchetypes(clubId);
  const rules = await loadRules(clubId);

  log(`[evaluator] rules=${rules.length}  archetypes=${archetypes.length}`);

  if (rules.length === 0) {
    log("[evaluator] no enabled rules — nothing to evaluate");
    return stats;
  }

  const events = await fetchUpcomingEvents(apiBase, apiKey);
  stats.events_fetched = events.length;
  log(`[evaluator] upcoming events (≤${LOOKAHEAD_HOURS}h): ${events.length}`);

  if (events.length === 0) return stats;

  const now = new Date();
  const eventIds = events.map((e) => e.id);
  const existingKeys = await loadExistingDecisionKeys(clubId, eventIds);

  for (const event of events) {
    const startTime = new Date(event.startTime);
    const hoursUntilStart = (startTime.getTime() - now.getTime()) / 3_600_000;

    // Classify the event to get its archetype
    const classResult = classifyEvent(
      {
        name: event.name ?? "",
        podplayType: event.customType ?? "",
        tags: event.tags ?? [],
        startTime: event.startTime,
      },
      archetypes,
    );
    const archetypeId = classResult.isExcluded ? null : (classResult.archetypeId ?? null);

    for (const rule of rules) {
      if (!matchRule(event, archetypeId, rule)) continue;

      // Find checkpoints whose trigger window has opened (offset_hours >= hoursUntilStart)
      const triggeredCheckpoints = rule.checkpoints
        .filter((cp) => cp.offset_hours >= hoursUntilStart)
        .sort((a, b) => b.index - a.index); // highest index first

      if (triggeredCheckpoints.length === 0) continue;

      // Only evaluate the highest-index triggered checkpoint per event×rule
      const cp = triggeredCheckpoints[0];
      const decisionKey = `${event.id}::${cp.index}`;

      if (existingKeys.has(decisionKey)) {
        stats.decisions_skipped_existing++;
        continue;
      }

      stats.events_evaluated++;

      // Fetch active signup count
      let signupCount = 0;
      try {
        signupCount = await fetchActiveSignupCount(apiBase, apiKey, event.id);
        await sleep(sleepMs);
      } catch (err: any) {
        stats.errors++;
        logger.error({ eventId: event.id, err: err.message }, "[evaluator] signup fetch failed");
        continue;
      }

      // Agent decision
      const decision: "CANCEL" | "ALERT" | "NO_ACTION" =
        signupCount < cp.min_signups ? cp.action : "NO_ACTION";

      // Native PodPlay rule snapshot
      const nativeThreshold = event.lowTurnoutAutoCancelAttendeeCount ?? null;
      const nativeHoursBefore = event.lowTurnoutAutoCancelHoursBefore ?? null;
      const nativeWouldCancel =
        nativeThreshold !== null && nativeHoursBefore !== null
          ? hoursUntilStart <= nativeHoursBefore && signupCount < nativeThreshold
          : null;

      log(
        `[evaluator] event=${event.id.slice(0, 8)} cp=${cp.index} ` +
          `signups=${signupCount}/${cp.min_signups} → ${decision}` +
          (dryRun ? " [DRY-RUN]" : ""),
      );

      if (dryRun) {
        stats.decisions_written++;
        existingKeys.add(decisionKey);
        continue;
      }

      // Write decision row
      const row = {
        club_id: clubId,
        event_id: event.id,
        checkpoint_index: cp.index,
        rule_id: rule.id,
        rule_name: rule.name,
        event_name: event.name ?? null,
        event_start_time: event.startTime,
        archetype_id: archetypeId ?? null,
        signup_count: signupCount,
        total_teams: event.totalTeams ?? 0,
        hours_before_start: Math.round(hoursUntilStart * 100) / 100,
        checkpoint_offset_hours: cp.offset_hours,
        checkpoint_min_signups: cp.min_signups,
        decision,
        mode: rule.mode,
        executed: false,
        native_threshold: nativeThreshold,
        native_hours_before: nativeHoursBefore,
        native_would_cancel: nativeWouldCancel,
      };

      const { error: insertErr } = await supabase
        .from("programming_decisions")
        .insert(row);

      if (insertErr) {
        if (insertErr.code === "23505") {
          // Unique violation — already evaluated (race condition)
          stats.decisions_skipped_existing++;
        } else {
          stats.errors++;
          logger.error({ event: event.id, cp: cp.index, insertErr }, "[evaluator] insert failed");
        }
      } else {
        stats.decisions_written++;
        existingKeys.add(decisionKey);
      }
    }
  }

  log(
    `[evaluator] done — fetched=${stats.events_fetched} ` +
      `evaluated=${stats.events_evaluated} ` +
      `written=${stats.decisions_written} ` +
      `skipped_existing=${stats.decisions_skipped_existing} ` +
      `errors=${stats.errors}`,
  );
  return stats;
}

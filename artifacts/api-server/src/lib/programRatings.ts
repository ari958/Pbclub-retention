/**
 * programRatings — nightly rating engine for the program catalog.
 *
 * Fill rate source:  event_fill table (historical, final, full-population)
 *   fill_rate = final_signups / total_teams  (pre-computed by eventFillSync)
 *   Denominator: totalTeams (seat count — teamSize NOT used)
 *   Numerator:   PodPlay signups._total (all registrants, not our member subset)
 *
 * Velocity + new-player share: attendances table (TRACKED-MEMBER-ONLY SIGNAL)
 *   These metrics cover only the members we track — a biased fraction of
 *   true session attendance (typically 2–6× undercounted vs. signups._total).
 *   Always labeled as "member-subset" signals, not full-population metrics.
 *
 * Rating window: attended_at / start_time >= RATING_START (2026-02-01 ET).
 * First-attendance detection uses FULL history (not windowed) per spec.
 *
 * Output: upserts to program_ratings keyed (program_id, daily_peak, season).
 */

import { supabase } from "./supabaseClient";
import {
  loadArchetypes,
  classifyEvent,
  isDailyPeak,
  isPeakSeason,
} from "./classifyEvent";
import { logger } from "./logger";

// ── Constants ─────────────────────────────────────────────────────────────────

const RATING_START_ISO = "2026-02-01T05:00:00.000Z";
const SEASONS = ["peak", "off_peak"] as const;
type Season = (typeof SEASONS)[number];

// ── Internal types ────────────────────────────────────────────────────────────

interface SlotAccum {
  fill_rates: number[];
  price_regular: number[];
  price_member: number[];
  velocity_days: number[];
  new_player_flags: boolean[];
}

function emptySlot(): SlotAccum {
  return {
    fill_rates: [],
    price_regular: [],
    price_member: [],
    velocity_days: [],
    new_player_flags: [],
  };
}

function slotKey(daily_peak: boolean, season: Season): string {
  return `${daily_peak ? "peak" : "offpeak"}_${season}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mode(arr: number[]): number | null {
  if (!arr.length) return null;
  const freq: Record<number, number> = {};
  for (const v of arr) freq[v] = (freq[v] ?? 0) + 1;
  return Number(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface RatingStats {
  archetypes_computed: number;
  event_fill_rows_used: number;
  attendances_classified: number;
  ratings_upserted: number;
  errors: number;
}

export async function computeProgramRatings(
  clubId: string,
  log: (msg: string) => void,
): Promise<RatingStats> {
  const stats: RatingStats = {
    archetypes_computed: 0,
    event_fill_rows_used: 0,
    attendances_classified: 0,
    ratings_upserted: 0,
    errors: 0,
  };

  // ── 1. Load archetypes ───────────────────────────────────────────────────
  log("[programRatings] Loading archetypes…");
  const archetypes = await loadArchetypes(clubId);
  log(`[programRatings] ${archetypes.length} active archetypes loaded`);

  const accumulators = new Map<string, Map<string, SlotAccum>>();
  for (const arch of archetypes) {
    const slotMap = new Map<string, SlotAccum>();
    for (const dp of [true, false]) {
      for (const s of SEASONS) {
        slotMap.set(slotKey(dp, s), emptySlot());
      }
    }
    accumulators.set(arch.id, slotMap);
  }

  // ── 2. Historical fill rates from event_fill ─────────────────────────────
  // Full-population metric: fill_rate = final_signups / total_teams (API-sourced)
  try {
    log("[programRatings] Reading historical fill from event_fill…");
    const { data: fillRows, error: fillErr } = await supabase
      .from("event_fill")
      .select("archetype_id, fill_rate, is_daily_peak, is_peak_season")
      .eq("club_id", clubId)
      .eq("is_canceled", false)
      .not("archetype_id", "is", null)
      .not("fill_rate", "is", null);

    if (fillErr) throw new Error(fillErr.message);

    for (const row of fillRows ?? []) {
      const dp = row.is_daily_peak as boolean;
      const s: Season = row.is_peak_season ? "peak" : "off_peak";
      const slot = accumulators.get(row.archetype_id as string)?.get(slotKey(dp, s));
      if (!slot) continue;
      slot.fill_rates.push(row.fill_rate as number);
      stats.event_fill_rows_used++;
    }

    log(`[programRatings] ${stats.event_fill_rows_used} event_fill rows loaded`);
  } catch (err: any) {
    logger.error({ err }, "[programRatings] event_fill read failed — skipping fill rate");
    log(`[programRatings] event_fill error (non-fatal): ${err.message}`);
    stats.errors++;
  }

  // ── 3. Attendances → velocity + new-player share (MEMBER-SUBSET SIGNALS) ─
  // NOTE: attendances covers only tracked members — typically 2–6× fewer than
  // true signups. These metrics are explicitly labeled as member-subset signals.
  try {
    log("[programRatings] Loading attendance data (member-subset signals)…");

    const firstAttend = new Map<string, string>(); // player_id → first event_id
    let page = 0;
    while (true) {
      const { data: batch, error } = await supabase
        .from("attendances")
        .select("player_id, event_id, attended_at")
        .not("player_id", "is", null)
        .not("event_id", "is", null)
        .order("attended_at", { ascending: true })
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error) throw new Error(`attendances full history: ${error.message}`);
      if (!batch?.length) break;

      for (const row of batch) {
        const pid = row.player_id as string;
        if (!firstAttend.has(pid)) {
          firstAttend.set(pid, row.event_id as string);
        }
      }
      if (batch.length < 1000) break;
      page++;
    }
    log(`[programRatings] First-attendance map built for ${firstAttend.size} members`);

    page = 0;
    let attClassified = 0;
    while (true) {
      const { data: batch, error } = await supabase
        .from("attendances")
        .select("player_id, event_id, program_name, program_type, attended_at, booked_at")
        .not("program_name", "is", null)
        .not("player_id", "is", null)
        .gte("attended_at", RATING_START_ISO)
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error) throw new Error(`attendances window: ${error.message}`);
      if (!batch?.length) break;

      for (const row of batch) {
        const result = classifyEvent(
          {
            name: row.program_name as string,
            podplayType: row.program_type ?? "",
          },
          archetypes,
        );
        if (result.isExcluded) continue;

        attClassified++;
        const dp = row.attended_at ? isDailyPeak(row.attended_at as string) : false;
        const s: Season =
          row.attended_at
            ? isPeakSeason(row.attended_at as string)
              ? "peak"
              : "off_peak"
            : "off_peak";
        const slot = accumulators.get(result.archetypeId)?.get(slotKey(dp, s));
        if (!slot) continue;

        if (row.booked_at && row.attended_at) {
          const days =
            (new Date(row.attended_at as string).getTime() -
              new Date(row.booked_at as string).getTime()) /
            86_400_000;
          if (days >= 0 && days < 365) slot.velocity_days.push(days);
        }

        const pid = row.player_id as string;
        const eid = row.event_id as string;
        const isNew = firstAttend.get(pid) === eid;
        slot.new_player_flags.push(isNew);
      }
      if (batch.length < 1000) break;
      page++;
    }
    stats.attendances_classified = attClassified;
    log(
      `[programRatings] Member-subset: classified ${attClassified} attendance rows ` +
        `(velocity + new-player share only — not fill rate)`,
    );
  } catch (err: any) {
    logger.error({ err }, "[programRatings] Attendance processing failed");
    log(`[programRatings] Attendance error (non-fatal): ${err.message}`);
    stats.errors++;
  }

  // ── 4. Upsert program_ratings ─────────────────────────────────────────────
  log("[programRatings] Upserting ratings…");
  const now = new Date().toISOString();
  const rows: object[] = [];

  for (const arch of archetypes) {
    const slotMap = accumulators.get(arch.id);
    if (!slotMap) continue;

    let hasAnyData = false;
    for (const dp of [true, false]) {
      for (const s of SEASONS) {
        const slot = slotMap.get(slotKey(dp, s));
        if (!slot) continue;
        const eventCount = slot.fill_rates.length;
        const attCount = slot.new_player_flags.length;
        if (eventCount === 0 && attCount === 0) continue;

        hasAnyData = true;
        const fillRate =
          eventCount > 0
            ? slot.fill_rates.reduce((a, b) => a + b, 0) / eventCount
            : null;
        const medVelocity = median(slot.velocity_days);
        const newShare =
          attCount > 0
            ? slot.new_player_flags.filter(Boolean).length / attCount
            : null;

        rows.push({
          program_id: arch.id,
          club_id: clubId,
          daily_peak: dp,
          season: s,
          fill_rate:
            fillRate !== null ? Math.round(fillRate * 1000) / 1000 : null,
          event_count: eventCount,
          median_velocity_days:
            medVelocity !== null ? Math.round(medVelocity * 10) / 10 : null,
          new_player_share:
            newShare !== null ? Math.round(newShare * 1000) / 1000 : null,
          modal_price_regular: mode(slot.price_regular),
          modal_price_member: mode(slot.price_member),
          computed_at: now,
        });
      }
    }
    if (hasAnyData) stats.archetypes_computed++;
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from("program_ratings")
      .upsert(rows, { onConflict: "program_id,daily_peak,season" });
    if (error) {
      logger.error({ error }, "[programRatings] Upsert failed");
      log(`[programRatings] Upsert error: ${error.message}`);
      stats.errors++;
    } else {
      stats.ratings_upserted = rows.length;
      log(`[programRatings] Upserted ${rows.length} rating rows`);
    }
  } else {
    log("[programRatings] No rating rows to upsert — no classified data in window");
  }

  return stats;
}

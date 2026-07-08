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

// ── Variant helpers ───────────────────────────────────────────────────────────
// Variants = per-raw-program-name breakdown within an archetype.
// Names sourced from attendances.program_name (member-subset, but name is reliable).

export interface VariantDayStats {
  fill_rate: number | null;
  event_count: number;
}

export interface ProgramVariant {
  raw_name: string;
  event_count: number;
  peak_day: VariantDayStats | null;
  off_peak_day: VariantDayStats | null;
}

interface FillRow {
  event_id: string;
  archetype_id: string;
  fill_rate: number;
  is_daily_peak: boolean;
}

// Load all (event_id, program_name) pairs from attendances without a large IN clause
// (avoids PostgREST URL-length limit). We paginate 1000 rows at a time and dedup
// in memory, then the caller filters to only the event_ids it cares about.
async function fetchEventNameMap(neededIds: Set<string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!neededIds.size) return map;
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from("attendances")
      .select("event_id, program_name")
      .not("event_id", "is", null)
      .not("program_name", "is", null)
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`fetchEventNameMap: ${error.message}`);
    if (!data?.length) break;
    for (const row of data) {
      const eid = row.event_id as string;
      if (neededIds.has(eid) && !map.has(eid) && row.program_name)
        map.set(eid, row.program_name as string);
    }
    if (data.length < 1000) break;
    page++;
  }
  return map;
}

function buildVariantMap(
  fillRows: FillRow[],
  eventNameMap: Map<string, string>,
): Map<string, ProgramVariant[]> {
  // archetypeId → raw_name → { peak: fills[], offpeak: fills[] }
  const accum = new Map<string, Map<string, { peak: number[]; offpeak: number[] }>>();

  for (const row of fillRows) {
    const name = eventNameMap.get(row.event_id);
    if (!name) continue;
    if (!accum.has(row.archetype_id)) accum.set(row.archetype_id, new Map());
    const byName = accum.get(row.archetype_id)!;
    if (!byName.has(name)) byName.set(name, { peak: [], offpeak: [] });
    const slots = byName.get(name)!;
    const clamped = Math.min(row.fill_rate, 1.0);
    if (row.is_daily_peak) slots.peak.push(clamped);
    else slots.offpeak.push(clamped);
  }

  const result = new Map<string, ProgramVariant[]>();
  for (const [archetypeId, byName] of accum) {
    const variants: ProgramVariant[] = [];
    for (const [raw_name, slots] of byName) {
      const totalN = slots.peak.length + slots.offpeak.length;
      const avgFill = (arr: number[]) =>
        arr.length > 0
          ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 1000) / 1000
          : null;
      variants.push({
        raw_name,
        event_count: totalN,
        peak_day:
          slots.peak.length > 0
            ? { fill_rate: avgFill(slots.peak), event_count: slots.peak.length }
            : null,
        off_peak_day:
          slots.offpeak.length > 0
            ? { fill_rate: avgFill(slots.offpeak), event_count: slots.offpeak.length }
            : null,
      });
    }
    variants.sort((a, b) => b.event_count - a.event_count);
    result.set(archetypeId, variants);
  }
  return result;
}

// Fetch all classified event_fill rows for a club (optionally within a window)
// and build the archetype → variants map.  Used by both catalog paths.
export async function fetchVariantsForClub(
  clubId: string,
  cutoff?: string,
): Promise<Map<string, ProgramVariant[]>> {
  let query = supabase
    .from("event_fill")
    .select("event_id, archetype_id, fill_rate, is_daily_peak")
    .eq("club_id", clubId)
    .eq("is_canceled", false)
    .not("archetype_id", "is", null)
    .not("fill_rate", "is", null);
  if (cutoff) query = (query as any).gte("start_time", cutoff);
  const { data, error } = await query;
  if (error) throw new Error(`fetchVariantsForClub: ${error.message}`);
  const rows: FillRow[] = (data ?? []).map((r: any) => ({
    event_id: r.event_id as string,
    archetype_id: r.archetype_id as string,
    fill_rate: r.fill_rate as number,
    is_daily_peak: r.is_daily_peak as boolean,
  }));
  const nameMap = await fetchEventNameMap(new Set(rows.map((r) => r.event_id)));
  return buildVariantMap(rows, nameMap);
}

// ── Windowed (on-the-fly) rating computation ──────────────────────────────────
// Season is collapsed — fill_rate and n aggregate over peak + off-peak season.
// Attendances skipped (velocity/new_player_share too thin over short windows).

export interface WindowedRatingSlice {
  daily_peak: boolean;
  fill_rate: number | null;
  event_count: number;
  median_velocity_days: null;
  new_player_share: null;
}

export interface WindowedArchetypeEntry {
  id: string;
  canonical_name: string;
  canonical_type: string;
  match_priority: number;
  overrides_podplay_type: boolean;
  ratings: WindowedRatingSlice[];
  variants: ProgramVariant[];
}

export async function computeProgramRatingsForWindow(
  clubId: string,
  days: number,
): Promise<{ computed_at: string; archetypes: WindowedArchetypeEntry[] }> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const now = new Date().toISOString();

  const archetypes = await loadArchetypes(clubId);

  // 2-slot accumulators: archetypeId → { peak: fills[], offpeak: fills[] }
  const accumulators = new Map<string, { peak: number[]; offpeak: number[] }>();
  for (const arch of archetypes) {
    accumulators.set(arch.id, { peak: [], offpeak: [] });
  }

  const { data: fillRows, error: fillErr } = await supabase
    .from("event_fill")
    .select("event_id, archetype_id, fill_rate, is_daily_peak")
    .eq("club_id", clubId)
    .eq("is_canceled", false)
    .not("archetype_id", "is", null)
    .not("fill_rate", "is", null)
    .gte("start_time", cutoff);

  if (fillErr) throw new Error(`event_fill window query: ${fillErr.message}`);

  const rawRows: FillRow[] = [];
  for (const row of fillRows ?? []) {
    const accum = accumulators.get(row.archetype_id as string);
    if (!accum) continue;
    const clamped = Math.min(row.fill_rate as number, 1.0);
    if (row.is_daily_peak) accum.peak.push(clamped);
    else accum.offpeak.push(clamped);
    rawRows.push({
      event_id: row.event_id as string,
      archetype_id: row.archetype_id as string,
      fill_rate: row.fill_rate as number,
      is_daily_peak: row.is_daily_peak as boolean,
    });
  }

  // Build variants
  const nameMap = await fetchEventNameMap(new Set(rawRows.map((r) => r.event_id)));
  const variantMap = buildVariantMap(rawRows, nameMap);

  const result: WindowedArchetypeEntry[] = [];
  for (const arch of archetypes) {
    const accum = accumulators.get(arch.id);
    if (!accum) continue;

    const ratings: WindowedRatingSlice[] = [];
    const avg = (arr: number[]) =>
      arr.length > 0
        ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 1000) / 1000
        : null;

    if (accum.peak.length > 0)
      ratings.push({ daily_peak: true,  fill_rate: avg(accum.peak),    event_count: accum.peak.length,    median_velocity_days: null, new_player_share: null });
    if (accum.offpeak.length > 0)
      ratings.push({ daily_peak: false, fill_rate: avg(accum.offpeak), event_count: accum.offpeak.length, median_velocity_days: null, new_player_share: null });

    result.push({
      id: arch.id,
      canonical_name: arch.canonical_name,
      canonical_type: arch.canonical_type,
      match_priority: arch.match_priority,
      overrides_podplay_type: arch.overrides_podplay_type,
      ratings,
      variants: variantMap.get(arch.id) ?? [],
    });
  }

  return { computed_at: now, archetypes: result };
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
      // Clamp to 1.0: 2 known overbookings exist where final_signups > total_teams
      // due to post-signup court edits in PodPlay. The event still happened and
      // counts as full; we cap rather than drop so n stays accurate.
      slot.fill_rates.push(Math.min(row.fill_rate as number, 1.0));
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

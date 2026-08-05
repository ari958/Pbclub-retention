import { supabase } from "./supabaseClient";
import { logger } from "./logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TimingArchetype = "early" | "mid" | "late" | "planner" | "default";

export interface PlayerTimingResult {
  avg_booking_lead_days: number;
  preferred_booking_dow: number;  // 0 = Sunday … 6 = Saturday
  preferred_booking_hour: number; // windowed: 8 | 13 | 19 | 18 (fallback)
  archetype: TimingArchetype;
  scheduling_lead_days: number;   // days to subtract from program start when scheduling send
}

// Scheduling lead to use per archetype
const ARCHETYPE_LEAD: Record<TimingArchetype, number> = {
  late:    1,
  mid:     2,
  early:   4,
  planner: 7,
  default: 3,
};

const DEFAULTS: PlayerTimingResult = {
  avg_booking_lead_days: 3,
  preferred_booking_dow: 3,   // Wednesday — neutral midweek
  preferred_booking_hour: 18,
  archetype: "default",
  scheduling_lead_days: ARCHETYPE_LEAD.default,
};

// ─── Timezone helpers ─────────────────────────────────────────────────────────

const ET = "America/New_York";

function etComponents(date: Date): {
  year: number; month: number; day: number;
  hour: number; minute: number; weekday: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    year:    parseInt(parts.year,  10),
    month:   parseInt(parts.month, 10),
    day:     parseInt(parts.day,   10),
    hour:    parseInt(parts.hour,  10) % 24,
    minute:  parseInt(parts.minute, 10),
    weekday: weekdayMap[parts.weekday] ?? 3,
  };
}

/** Build a Date that represents a specific local clock time in ET */
function setLocalTime(date: Date, hour: number, minute: number): Date {
  const { year, month, day } = etComponents(date);
  // Find ET UTC offset at noon that day
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const probeLocal = etComponents(probe);
  const offsetMin = 12 * 60 - (probeLocal.hour * 60 + probeLocal.minute);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) + offsetMin * 60_000);
}

// ─── Mode helper ──────────────────────────────────────────────────────────────

function mode(values: number[], tieBreaker?: number): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = tieBreaker ?? values[0];
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && tieBreaker !== undefined && v === tieBreaker)) {
      best = v; bestCount = c;
    }
  }
  return best;
}

function hourToWindow(hour: number): number | null {
  if (hour >= 6  && hour <= 10) return 8;
  if (hour >= 11 && hour <= 16) return 13;
  if (hour >= 17 && hour <= 22) return 19;
  return null; // outside 6–22 → excluded from window preference
}

function archetypeFromLead(avg: number): TimingArchetype {
  if (avg < 0.5) return "late";
  if (avg < 2)   return "mid";
  if (avg <= 5)  return "early";
  return "planner";
}

// ─── Persist helpers ──────────────────────────────────────────────────────────

async function persistTiming(playerId: string, result: PlayerTimingResult): Promise<void> {
  const { error } = await supabase
    .from("players")
    .update({
      avg_booking_lead_days:  result.avg_booking_lead_days,
      preferred_booking_hour: result.preferred_booking_hour,
      preferred_booking_dow:  result.preferred_booking_dow,
      attendance_archetype:   result.archetype,
      timing_computed_at:     new Date().toISOString(),
    })
    .eq("id", playerId);
  if (error) {
    logger.warn({ playerId, err: error.message }, "[playerTiming] failed to cache timing (migration pending?)");
  }
}

// ─── FUNCTION 1: computePlayerTiming ──────────────────────────────────────────

export async function computePlayerTiming(
  playerId: string,
  forceRefresh = false,
): Promise<PlayerTimingResult> {

  // Cache check
  if (!forceRefresh) {
    const { data: row } = await supabase
      .from("players")
      .select("avg_booking_lead_days, preferred_booking_hour, preferred_booking_dow, attendance_archetype, timing_computed_at")
      .eq("id", playerId)
      .maybeSingle();

    if (
      row?.attendance_archetype != null &&
      row?.avg_booking_lead_days != null &&
      row?.timing_computed_at
    ) {
      const ageMs = Date.now() - new Date(row.timing_computed_at).getTime();
      if (ageMs < 24 * 60 * 60 * 1000) {
        const archetype = row.attendance_archetype as TimingArchetype;
        return {
          avg_booking_lead_days:  row.avg_booking_lead_days as number,
          preferred_booking_hour: (row.preferred_booking_hour as number) ?? DEFAULTS.preferred_booking_hour,
          preferred_booking_dow:  (row.preferred_booking_dow  as number) ?? DEFAULTS.preferred_booking_dow,
          archetype,
          scheduling_lead_days:   ARCHETYPE_LEAD[archetype] ?? ARCHETYPE_LEAD.default,
        };
      }
    }
  }

  // Fetch attendances with real booking timestamps.
  // 180-day window captures members who play ~2×/month (typical club cadence).
  // Phase 3.3: widened from 90d to 180d; minimum qualifying rows lowered to 2.
  const ninetyDaysAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await supabase
    .from("attendances")
    .select("attended_at, booked_at")
    .eq("player_id", playerId)
    .gte("attended_at", ninetyDaysAgo)
    .not("booked_at", "is", null);

  if (error) {
    logger.warn({ playerId, err: error.message }, "[playerTiming] query failed — returning defaults");
    return DEFAULTS;
  }

  // Filter: booked_at must be before attended_at (sanity check).
  // attended_at is date-only — treat as end of that UTC day (T23:59:59Z) so a booking
  // made earlier the same calendar date (e.g. same-day open play) is not incorrectly excluded.
  const valid = (rows ?? []).filter((r: any) => {
    if (!r.booked_at || !r.attended_at) return false;
    const attended = new Date(`${r.attended_at}T23:59:59Z`);
    return new Date(r.booked_at) < attended;
  });

  if (valid.length < 2) {
    // Fallback: use attended_at to at least get preferred DOW; hour defaults to 18
    const fallbackDows = (rows ?? [])
      .filter((r: any) => r.attended_at)
      .map((r: any) => etComponents(new Date(r.attended_at)).weekday);

    const preferred_booking_dow = fallbackDows.length > 0 ? mode(fallbackDows) : DEFAULTS.preferred_booking_dow;

    logger.info({ playerId, validRows: valid.length }, "[playerTiming] insufficient booked_at data — using defaults");
    const result: PlayerTimingResult = {
      ...DEFAULTS,
      preferred_booking_dow,
    };
    await persistTiming(playerId, result);
    return result;
  }

  // avg_booking_lead_days from real booking timestamps
  const leadDays = valid.map((r: any) => {
    const bookedMs   = new Date(r.booked_at).getTime();
    const attendedMs = new Date(r.attended_at).getTime();
    // attended_at is a date-only string; treat as local noon ET to avoid off-by-one
    return (attendedMs - bookedMs) / (1000 * 60 * 60 * 24);
  });
  const avg = Math.round(leadDays.reduce((s, v) => s + v, 0) / leadDays.length * 10) / 10;

  // preferred_booking_dow from booked_at in ET
  const dows = valid.map((r: any) => etComponents(new Date(r.booked_at)).weekday);
  const preferred_booking_dow = mode(dows);

  // preferred_booking_hour from booked_at in ET, grouped into windows
  const windowVotes: number[] = [];
  for (const r of valid) {
    const { hour } = etComponents(new Date(r.booked_at));
    const window = hourToWindow(hour);
    if (window !== null) windowVotes.push(window);
  }
  // Tie → prefer 19 (evening)
  const preferred_booking_hour = windowVotes.length > 0 ? mode(windowVotes, 19) : 18;

  const archetype = archetypeFromLead(avg);

  logger.info(
    { playerId, avg, preferred_booking_dow, preferred_booking_hour, archetype, validRows: valid.length },
    "[playerTiming] computed",
  );

  const result: PlayerTimingResult = {
    avg_booking_lead_days:  avg,
    preferred_booking_dow,
    preferred_booking_hour,
    archetype,
    scheduling_lead_days: ARCHETYPE_LEAD[archetype],
  };
  await persistTiming(playerId, result);
  return result;
}

// ─── FUNCTION: batchComputePlayerTiming ───────────────────────────────────────
//
// In-memory batch version of computePlayerTiming.  One DB read for all
// attendances + one DB read for all players, then N small upserts.
// Designed for the nightly chain and the /batch-timing endpoint.
//
// dryRun=true  → compute in-memory and return the distribution; write nothing.
// dryRun=false → compute and write attendance_archetype / avg_booking_lead_days
//                / preferred_booking_dow / timing_computed_at to players table.
// forceRefresh → bypass the 22-hour cache guard.

export interface BatchTimingResult {
  computed:       number;
  skipped_cached: number;
  distribution:  Record<TimingArchetype, number>;
  errors:         number;
}

export async function batchComputePlayerTiming(
  clubId: string,
  options: { dryRun?: boolean; forceRefresh?: boolean } = {},
): Promise<BatchTimingResult> {
  const { dryRun = false, forceRefresh = false } = options;
  const now = new Date();
  // 180-day window: same as computePlayerTiming — captures monthly members (Phase 3.3).
  const ninetyDaysAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // ── 1. Bulk-fetch all relevant attendances for the club ───────────────────
  const allRows: { player_id: string; attended_at: string; booked_at: string }[] = [];
  let aOff = 0;
  while (true) {
    const { data, error } = await supabase
      .from("attendances")
      .select("player_id, attended_at, booked_at")
      .eq("club_id", clubId)
      .not("booked_at", "is", null)
      .gte("attended_at", ninetyDaysAgo)
      .range(aOff, aOff + 999);
    if (error || !data?.length) break;
    allRows.push(...(data as any[]));
    if (data.length < 1000) break;
    aOff += 1000;
  }

  // Group by player_id
  const byPlayer = new Map<string, { attended_at: string; booked_at: string }[]>();
  for (const row of allRows) {
    if (!row.player_id) continue;
    if (!byPlayer.has(row.player_id)) byPlayer.set(row.player_id, []);
    byPlayer.get(row.player_id)!.push(row);
  }

  // ── 2. Fetch all players (id + timing cache timestamp only) ───────────────
  const players: { id: string; timing_computed_at: string | null }[] = [];
  let pOff = 0;
  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("id, timing_computed_at")
      .eq("club_id", clubId)
      .range(pOff, pOff + 999);
    if (error || !data?.length) break;
    players.push(...(data as any[]));
    if (data.length < 1000) break;
    pOff += 1000;
  }

  // ── 3. Compute timing for each player in memory ───────────────────────────
  const result: BatchTimingResult = {
    computed:       0,
    skipped_cached: 0,
    distribution:   { early: 0, mid: 0, late: 0, planner: 0, default: 0 },
    errors:         0,
  };

  type Update = {
    id:                    string;
    attendance_archetype:  TimingArchetype;
    avg_booking_lead_days: number;
    preferred_booking_dow: number;
    timing_computed_at:    string;
  };
  const updates: Update[] = [];
  const nowIso = now.toISOString();

  for (const player of players) {
    if (!forceRefresh && player.timing_computed_at) {
      const ageMs = now.getTime() - new Date(player.timing_computed_at).getTime();
      if (ageMs < 22 * 60 * 60 * 1000) { // 22 h — buffer vs 24 h on-demand cache
        result.skipped_cached++;
        continue;
      }
    }

    const rows = byPlayer.get(player.id) ?? [];
    const valid = rows.filter(r => {
      if (!r.booked_at || !r.attended_at) return false;
      return new Date(r.booked_at) < new Date(`${r.attended_at}T23:59:59Z`);
    });

    let archetype: TimingArchetype;
    let avgLead:   number;
    let preferred_booking_dow: number;

    if (valid.length < 2) {
      const fallbackDows = rows
        .filter(r => r.attended_at)
        .map(r => etComponents(new Date(r.attended_at)).weekday);
      preferred_booking_dow = fallbackDows.length > 0
        ? mode(fallbackDows)
        : DEFAULTS.preferred_booking_dow;
      archetype = "default";
      avgLead   = DEFAULTS.avg_booking_lead_days;
    } else {
      const leadDays = valid.map(r => {
        const bookedMs   = new Date(r.booked_at).getTime();
        const attendedMs = new Date(r.attended_at).getTime();
        return (attendedMs - bookedMs) / (1000 * 60 * 60 * 24);
      });
      avgLead = Math.round(
        (leadDays.reduce((s, v) => s + v, 0) / leadDays.length) * 10,
      ) / 10;
      preferred_booking_dow = mode(valid.map(r => etComponents(new Date(r.booked_at)).weekday));
      archetype = archetypeFromLead(avgLead);
    }

    result.distribution[archetype]++;
    result.computed++;
    if (!dryRun) {
      updates.push({ id: player.id, attendance_archetype: archetype,
                     avg_booking_lead_days: avgLead, preferred_booking_dow, timing_computed_at: nowIso });
    }
  }

  // ── 4. Batch-write (10-way concurrent updates) ────────────────────────────
  if (!dryRun && updates.length > 0) {
    const CONCURRENCY = 10;
    for (let i = 0; i < updates.length; i += CONCURRENCY) {
      const chunk = updates.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(
        chunk.map(u =>
          supabase.from("players").update({
            attendance_archetype:  u.attendance_archetype,
            avg_booking_lead_days: u.avg_booking_lead_days,
            preferred_booking_dow: u.preferred_booking_dow,
            timing_computed_at:    u.timing_computed_at,
          }).eq("id", u.id),
        ),
      );
      result.errors += settled.filter(r => r.error).length;
    }
  }

  logger.info({ clubId, dryRun, ...result }, "[batchPlayerTiming] complete");
  return result;
}

// ─── TCPA send-window constants (single definition point) ────────────────────
// queuePoller imports isInsideSendWindow; sanitizeScheduledSendAt uses the
// constants directly so it can distinguish before-open vs after-close for rolling.

const TCPA_OPEN_WEEKDAY = 8.0;  // 08:00 ET
const TCPA_OPEN_WEEKEND = 8.5;  // 08:30 ET
const TCPA_CLOSE        = 19.5; // 19:30 ET (courtesy buffer)

/** True when `date` falls inside the legal SMS send window in ET. */
export function isInsideSendWindow(date: Date): boolean {
  const lc = etComponents(date);
  const isWeekend = lc.weekday === 0 || lc.weekday === 6;
  const localHour = lc.hour + lc.minute / 60;
  return localHour >= (isWeekend ? TCPA_OPEN_WEEKEND : TCPA_OPEN_WEEKDAY)
      && localHour <= TCPA_CLOSE;
}

// ─── FUNCTION 2: sanitizeScheduledSendAt ──────────────────────────────────────

export function sanitizeScheduledSendAt(
  proposedSendAt: Date,
  timezone = ET,
): Date | null {
  const lc = etComponents(proposedSendAt);
  const isWeekend = lc.weekday === 0 || lc.weekday === 6;

  const windowOpenHour  = isWeekend ? TCPA_OPEN_WEEKEND : TCPA_OPEN_WEEKDAY;

  const localHour = lc.hour + lc.minute / 60;

  let result: Date;

  if (localHour < windowOpenHour) {
    const openMin  = Math.round((windowOpenHour % 1) * 60);
    const openHour = Math.floor(windowOpenHour);
    result = setLocalTime(proposedSendAt, openHour, openMin);
  } else if (localHour > TCPA_CLOSE) {
    const tomorrow  = new Date(proposedSendAt.getTime() + 24 * 60 * 60 * 1000);
    const tmWeekend = (() => { const d = etComponents(tomorrow).weekday; return d === 0 || d === 6; })();
    result = setLocalTime(tomorrow, 8, tmWeekend ? 30 : 0);
  } else {
    result = proposedSendAt;
  }

  // Past → skip
  if (result <= new Date()) return null;
  return result;
}

// ─── FUNCTION 3: computeScheduledSendAt ───────────────────────────────────────

export async function computeScheduledSendAt(
  playerId: string,
  programStartAt: Date | null,
  urgencyOverride = false,
  timezone = ET,
): Promise<{ scheduledSendAt: Date | null; archetype: TimingArchetype }> {

  // Urgent path — send in 5 minutes
  const within48h =
    programStartAt !== null &&
    programStartAt.getTime() - Date.now() <= 48 * 60 * 60 * 1000;

  if (urgencyOverride || within48h) {
    const proposed  = new Date(Date.now() + 5 * 60 * 1000);
    const sanitized = sanitizeScheduledSendAt(proposed, timezone);
    return { scheduledSendAt: sanitized, archetype: "late" };
  }

  const timing = await computePlayerTiming(playerId);
  const leadMs  = timing.scheduling_lead_days * 24 * 60 * 60 * 1000;

  let proposedSendAt: Date;

  if (programStartAt !== null) {
    const idealDate    = new Date(programStartAt.getTime() - leadMs);
    proposedSendAt     = setLocalTime(idealDate, timing.preferred_booking_hour, 0);
  } else {
    // No program date — next occurrence of preferred hour, at least 2 h from now
    const minSend          = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const todayAtPreferred = setLocalTime(new Date(), timing.preferred_booking_hour, 0);
    proposedSendAt = todayAtPreferred > minSend
      ? todayAtPreferred
      : new Date(todayAtPreferred.getTime() + 24 * 60 * 60 * 1000);
  }

  const sanitized = sanitizeScheduledSendAt(proposedSendAt, timezone);
  return { scheduledSendAt: sanitized, archetype: timing.archetype };
}

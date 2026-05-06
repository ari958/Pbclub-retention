import { supabase } from "./supabaseClient";
import { logger } from "./logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TimingArchetype = "early" | "mid" | "late" | "default";

export interface PlayerTimingResult {
  avg_booking_lead_days: number;
  preferred_send_hour: number;
  archetype: TimingArchetype;
}

const DEFAULTS: PlayerTimingResult = {
  avg_booking_lead_days: 3,
  preferred_send_hour: 18,
  archetype: "default",
};

// ─── Helper: get local-time components from a UTC Date ───────────────────────

function localComponents(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  // weekday: 0 = Sunday … 6 = Saturday
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour, 10) % 24, // "24" can appear for midnight
    minute: parseInt(parts.minute, 10),
    weekday: weekdayMap[parts.weekday] ?? 1,
  };
}

/** Build a Date that represents a specific local clock time in the given timezone */
function setLocalTime(
  date: Date,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const { year, month, day } = localComponents(date, timezone);
  // Construct ISO-like string in that zone — binary search over UTC offsets
  // Approach: use the date's local midnight, then add hours/minutes
  const tzOffset = (() => {
    const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const lc = localComponents(probe, timezone);
    const localNoon = lc.hour * 60 + lc.minute;
    return 12 * 60 - localNoon; // UTC - local (in minutes)
  })();
  const utcMs =
    Date.UTC(year, month - 1, day, hour, minute, 0) + tzOffset * 60_000;
  return new Date(utcMs);
}

// ─── FUNCTION 1: computePlayerTiming ──────────────────────────────────────────

/**
 * Derive send-timing archetype from a player's actual booking behavior.
 * Results are cached for 24 h (unless forceRefresh=true).
 */
export async function computePlayerTiming(
  playerId: string,
  forceRefresh = false,
): Promise<PlayerTimingResult> {
  // Cache check
  if (!forceRefresh) {
    const { data: row } = await supabase
      .from("players")
      .select("avg_booking_lead_days, preferred_send_hour, timing_computed_at")
      .eq("id", playerId)
      .maybeSingle();

    if (
      row?.avg_booking_lead_days != null &&
      row?.preferred_send_hour != null &&
      row?.timing_computed_at
    ) {
      const ageMs = Date.now() - new Date(row.timing_computed_at).getTime();
      if (ageMs < 24 * 60 * 60 * 1000) {
        const avg = row.avg_booking_lead_days as number;
        const hour = row.preferred_send_hour as number;
        const archetype: TimingArchetype =
          avg < 1.5 ? "late" : avg <= 5 ? "mid" : "early";
        return { avg_booking_lead_days: avg, preferred_send_hour: hour, archetype };
      }
    }
  }

  // Fetch attendance rows from last 90 days where attended_at > created_at
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await supabase
    .from("attendances")
    .select("attended_at, created_at")
    .eq("player_id", playerId)
    .gte("attended_at", ninetyDaysAgo);

  if (error) {
    logger.warn({ playerId, err: error.message }, "[playerTiming] attendance query failed — returning default");
    return DEFAULTS;
  }

  // Filter: attended_at must be after created_at (real booking, not sync artefact)
  const valid = (rows ?? []).filter((r: any) => {
    if (!r.attended_at || !r.created_at) return false;
    return new Date(r.attended_at) > new Date(r.created_at);
  });

  if (valid.length < 3) {
    logger.info({ playerId, validRows: valid.length }, "[playerTiming] insufficient data — using defaults");
    await persistTiming(playerId, DEFAULTS.avg_booking_lead_days, DEFAULTS.preferred_send_hour);
    return DEFAULTS;
  }

  // avg_booking_lead_days — fractional days between booking and session
  const leadDays = valid.map((r: any) => {
    const attendedMs = new Date(r.attended_at).getTime();
    const bookedMs = new Date(r.created_at).getTime();
    return (attendedMs - bookedMs) / (1000 * 60 * 60 * 24);
  });
  const avg = Math.round(leadDays.reduce((s, v) => s + v, 0) / leadDays.length * 10) / 10;

  // preferred_send_hour — from booking hour (created_at), ignoring outside 6–22
  const windowCounts = { morning: 0, midday: 0, evening: 0 };
  for (const r of valid) {
    const hour = new Date(r.created_at).getUTCHours(); // raw UTC — fine for relative grouping
    if (hour >= 6 && hour <= 10) windowCounts.morning++;
    else if (hour >= 11 && hour <= 16) windowCounts.midday++;
    else if (hour >= 17 && hour <= 22) windowCounts.evening++;
    // outside 6–22: skip (late-night bookers get no window credit)
  }

  let preferred_send_hour: number;
  const max = Math.max(windowCounts.morning, windowCounts.midday, windowCounts.evening);
  if (max === 0) {
    preferred_send_hour = 19; // all bookings outside 6–22 → default to evening
  } else if (windowCounts.evening === max) {
    preferred_send_hour = 19; // tie or evening wins
  } else if (windowCounts.midday === max) {
    preferred_send_hour = 13;
  } else {
    preferred_send_hour = 8;
  }

  const archetype: TimingArchetype = avg < 1.5 ? "late" : avg <= 5 ? "mid" : "early";

  logger.info(
    { playerId, avg, preferred_send_hour, archetype, validRows: valid.length, windowCounts },
    "[playerTiming] computed",
  );

  await persistTiming(playerId, avg, preferred_send_hour);
  return { avg_booking_lead_days: avg, preferred_send_hour, archetype };
}

async function persistTiming(playerId: string, avg: number, hour: number): Promise<void> {
  const { error } = await supabase
    .from("players")
    .update({
      avg_booking_lead_days: avg,
      preferred_send_hour: hour,
      timing_computed_at: new Date().toISOString(),
    })
    .eq("id", playerId);
  if (error) {
    // Columns may not exist yet (migration pending) — log and continue
    logger.warn({ playerId, err: error.message }, "[playerTiming] failed to cache timing (migration pending?)");
  }
}

// ─── FUNCTION 2: sanitizeScheduledSendAt ──────────────────────────────────────

/**
 * Clamp a proposed send time to the courtesy window (no blasts before 08:00
 * or after 19:30 local). Returns null if the clamped time is in the past.
 */
export function sanitizeScheduledSendAt(
  proposedSendAt: Date,
  timezone = "America/New_York",
): Date | null {
  const lc = localComponents(proposedSendAt, timezone);
  const isWeekend = lc.weekday === 0 || lc.weekday === 6; // Sun=0, Sat=6

  const windowOpenHour = isWeekend ? 8.5 : 8; // 08:30 weekends, 08:00 weekdays
  const windowCloseHour = 19.5; // 19:30 always

  const localHour = lc.hour + lc.minute / 60;

  let result: Date;

  if (localHour < windowOpenHour) {
    // Too early — push to window open same day
    const openMinutes = Math.round((windowOpenHour % 1) * 60);
    const openHour = Math.floor(windowOpenHour);
    result = setLocalTime(proposedSendAt, openHour, openMinutes, timezone);
  } else if (localHour > windowCloseHour) {
    // Too late — push to window open next day
    const tomorrow = new Date(proposedSendAt.getTime() + 24 * 60 * 60 * 1000);
    const tmLc = localComponents(tomorrow, timezone);
    const tmWeekend = tmLc.weekday === 0 || tmLc.weekday === 6;
    const tmOpenHour = tmWeekend ? 8 : 8;
    const tmOpenMinutes = tmWeekend ? 30 : 0;
    result = setLocalTime(tomorrow, tmOpenHour, tmOpenMinutes, timezone);
  } else {
    result = proposedSendAt;
  }

  // If result is in the past → skip
  if (result <= new Date()) {
    return null;
  }

  return result;
}

// ─── FUNCTION 3: computeScheduledSendAt ───────────────────────────────────────

/**
 * Determine when an outbound message should be sent based on:
 * - Player's booking behavior archetype
 * - Program start date (if known)
 * - Urgency override (e.g. last-minute program)
 *
 * Returns null if the sanitized time is in the past or the program has started.
 */
export async function computeScheduledSendAt(
  playerId: string,
  programStartAt: Date | null,
  urgencyOverride = false,
  timezone = "America/New_York",
): Promise<{ scheduledSendAt: Date | null; archetype: TimingArchetype }> {
  // Urgent: send in 5 minutes
  const within48h =
    programStartAt !== null &&
    programStartAt.getTime() - Date.now() <= 48 * 60 * 60 * 1000;

  if (urgencyOverride || within48h) {
    const proposed = new Date(Date.now() + 5 * 60 * 1000);
    const sanitized = sanitizeScheduledSendAt(proposed, timezone);
    return { scheduledSendAt: sanitized, archetype: "late" };
  }

  // Compute / retrieve timing profile
  const timing = await computePlayerTiming(playerId);

  let proposedSendAt: Date;

  if (programStartAt !== null) {
    // Shift back from program start by avg_booking_lead_days
    const leadMs = timing.avg_booking_lead_days * 24 * 60 * 60 * 1000;
    const idealDate = new Date(programStartAt.getTime() - leadMs);
    // Override time component to preferred_send_hour in player timezone
    proposedSendAt = setLocalTime(idealDate, timing.preferred_send_hour, 0, timezone);
  } else {
    // No program date — send at preferred_send_hour, at least 2 h from now
    const minSend = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const todayAtPreferred = setLocalTime(new Date(), timing.preferred_send_hour, 0, timezone);
    proposedSendAt = todayAtPreferred > minSend ? todayAtPreferred : new Date(todayAtPreferred.getTime() + 24 * 60 * 60 * 1000);
  }

  const sanitized = sanitizeScheduledSendAt(proposedSendAt, timezone);
  return { scheduledSendAt: sanitized, archetype: timing.archetype };
}

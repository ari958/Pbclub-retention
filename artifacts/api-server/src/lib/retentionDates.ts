const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ET = "America/New_York";
export const DEFAULT_RETENTION_LOOKBACK_DAYS = 3;
export const MAX_RETENTION_LOOKBACK_DAYS = 30;
export const ALLOWED_RETENTION_LOOKBACK_DAYS = [3, 7, 14, 30] as const;

export function normalizeRetentionLookbackDays(value = DEFAULT_RETENTION_LOOKBACK_DAYS): number {
  if (!Number.isInteger(value) || !ALLOWED_RETENTION_LOOKBACK_DAYS.includes(value as (typeof ALLOWED_RETENTION_LOOKBACK_DAYS)[number])) {
    throw new RangeError(`Retention lookback days must be one of ${ALLOWED_RETENTION_LOOKBACK_DAYS.join(", ")}`);
  }
  return value;
}

export function toEtDate(value: string | Date, timezone = ET): string {
  if (typeof value === "string" && DATE_ONLY_RE.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid attendance/event date: ${String(value)}`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addCalendarDays(date: string, delta: number): string {
  if (!DATE_ONLY_RE.test(date)) throw new Error(`Expected YYYY-MM-DD date, received ${date}`);
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + delta, 12));
  return shifted.toISOString().slice(0, 10);
}

export function isRetentionTriggerDate(
  eventDate: string,
  todayET: string,
  lookbackDays = DEFAULT_RETENTION_LOOKBACK_DAYS,
): boolean {
  const days = normalizeRetentionLookbackDays(lookbackDays);
  return eventDate >= addCalendarDays(todayET, -days) && eventDate < todayET;
}

/** Conservative raw attendance-date candidate gate before live event verification. */
export function isAttendanceDateNearRetentionWindow(
  attendanceDate: string,
  todayET: string,
  lookbackDays = DEFAULT_RETENTION_LOOKBACK_DAYS,
): boolean {
  const days = normalizeRetentionLookbackDays(lookbackDays);
  // Keep one extra day so a verified event up to one day from attendance can
  // still corroborate a trigger on the actual lookback boundary.
  return attendanceDate >= addCalendarDays(todayET, -(days + 1)) && attendanceDate <= todayET;
}

export function calendarDayDistance(left: string, right: string): number {
  const parse = (value: string) => {
    if (!DATE_ONLY_RE.test(value)) throw new Error(`Expected YYYY-MM-DD date, received ${value}`);
    const [year, month, day] = value.split("-").map(Number);
    return Date.UTC(year, month - 1, day, 12);
  };
  return Math.abs(parse(left) - parse(right)) / 86_400_000;
}

/** Pure status predicate over normalized attendance facts and a verified trigger date. */
export function hasNonLtpAttendanceAfterTrigger(
  rows: ReadonlyArray<{ attendance_date: string; is_ltp: boolean }>,
  verifiedTriggerDate: string,
): boolean {
  return rows.some((row) => !row.is_ltp && row.attendance_date > verifiedTriggerDate);
}

export function retentionSendDateMatchesSchedule(
  generatedSendDateEt: string | undefined,
  scheduledAt: string | Date,
): boolean {
  return !!generatedSendDateEt && generatedSendDateEt === toEtDate(scheduledAt);
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];

function calendarOrdinal(date: string): number {
  if (!DATE_ONLY_RE.test(date)) throw new Error(`Expected YYYY-MM-DD date, received ${date}`);
  const [year, month, day] = date.split("-").map(Number);
  const normalized = new Date(Date.UTC(year, month - 1, day, 12));
  if (normalized.toISOString().slice(0, 10) !== date) throw new Error(`Expected valid YYYY-MM-DD date, received ${date}`);
  return normalized.getTime();
}

export function retentionWeekday(date: string): string {
  const instant = new Date(calendarOrdinal(date));
  return WEEKDAY_NAMES[instant.getUTCDay()];
}

/**
 * Human date reference for the LTP trigger, relative to the intended send date
 * in New York. Do not derive this from the server's local timezone.
 */
export function retentionDatePhrase(triggerDate: string, intendedSendAt: string | Date): string {
  const sendDate = toEtDate(intendedSendAt);
  const dayOffset = (calendarOrdinal(triggerDate) - calendarOrdinal(sendDate)) / 86_400_000;
  if (dayOffset === -1) return "yesterday";
  if (dayOffset !== 0 && Math.abs(dayOffset) <= 6) return retentionWeekday(triggerDate);
  const [year, month, day] = triggerDate.split("-").map(Number);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Expected valid YYYY-MM-DD date, received ${triggerDate}`);
  }
  return `on ${MONTH_NAMES[month - 1]} ${day}`;
}

function etOffsetMilliseconds(instant: number): number {
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    timeZoneName: "longOffset",
    hour: "2-digit",
  }).formatToParts(new Date(instant)).find((part) => part.type === "timeZoneName")?.value;
  if (!zone || zone === "GMT") return 0;
  const match = /^GMT([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!match) throw new Error(`Could not resolve ET UTC offset: ${zone}`);
  const offset = (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  return match[1] === "+" ? offset : -offset;
}

/** UTC instant corresponding to 00:00 ET for a calendar date, including DST. */
export function utcEtMidnight(date: string): Date {
  if (!DATE_ONLY_RE.test(date)) throw new Error(`Expected YYYY-MM-DD date, received ${date}`);
  const [year, month, day] = date.split("-").map(Number);
  const localMidnightAsUtc = Date.UTC(year, month - 1, day);
  let instant = localMidnightAsUtc;
  for (let attempt = 0; attempt < 4; attempt++) {
    const corrected = localMidnightAsUtc - etOffsetMilliseconds(instant);
    if (corrected === instant) return new Date(instant);
    instant = corrected;
  }
  return new Date(instant);
}
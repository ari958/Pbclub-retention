const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ET = "America/New_York";

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

export function isRetentionTriggerDate(eventDate: string, todayET: string): boolean {
  return eventDate >= addCalendarDays(todayET, -7) && eventDate < todayET;
}

/** Conservative raw attendance-date candidate gate before live event verification. */
export function isAttendanceDateNearRetentionWindow(attendanceDate: string, todayET: string): boolean {
  return attendanceDate >= addCalendarDays(todayET, -8) && attendanceDate <= todayET;
}

export function calendarDayDistance(left: string, right: string): number {
  const parse = (value: string) => {
    if (!DATE_ONLY_RE.test(value)) throw new Error(`Expected YYYY-MM-DD date, received ${value}`);
    const [year, month, day] = value.split("-").map(Number);
    return Date.UTC(year, month - 1, day, 12);
  };
  return Math.abs(parse(left) - parse(right)) / 86_400_000;
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
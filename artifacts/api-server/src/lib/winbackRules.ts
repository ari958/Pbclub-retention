/**
 * Lapsing-regular win-back: pure rules (no I/O), so every decision is testable.
 *
 * Ari's decisions (2026-11-24):
 *   - A "regular" has 4+ visits in the 60 days ending on their last visit.
 *   - They are overdue at max(14, 2 x their median gap between visits) days,
 *     and only while that is 30 days or less after the last visit.
 *   - One text, no promo code, fixed templates. Name the next session of their
 *     usual program when one has open spots within the next 6 days of the send
 *     date; otherwise a generic nudge with the booking page.
 *   - 20% holdout (playbook row), 90+ days between win-back texts per player.
 * Baseline (lapsing_regulars_sizing.sql, 2026-11-24): ~13 a week; 39% return
 * within 14 days and 51% within 30 days without a text.
 */
import { addCalendarDays, calendarDayDistance, retentionWeekday, toEtDate } from "./retentionDates";

export const WINBACK_PLAYBOOK_KEY = "winback_regular";
export const WINBACK_MIN_VISITS_60D = 4;
export const WINBACK_MIN_OVERDUE_DAYS = 14;
export const WINBACK_MAX_DAYS_SINCE = 30;
export const WINBACK_MIN_GAP_DAYS = 90;
/** A named session must start within this many days after the send date. */
export const WINBACK_SESSION_HORIZON_DAYS = 6;
/** ... and at least this long after the text goes out. */
export const WINBACK_SESSION_MIN_LEAD_MS = 2 * 60 * 60 * 1000;
/** Contact limits checked before drafting (sent texts, any flow). */
export const WINBACK_CONTACT_COOLDOWN_DAYS = 7;
export const WINBACK_MAX_TEXTS_30D = 2;
/** The attendance sync must have data this recent, or every regular looks lapsed. */
export const WINBACK_MAX_DATA_AGE_DAYS = 3;
/** Stop refreshing a draft nobody approved after this many days; it is skipped. */
export const WINBACK_DRAFT_MAX_AGE_DAYS = 7;

export interface WinbackVisit {
  /** Club-local YYYY-MM-DD. */
  date: string;
  program: string | null;
}

export interface WinbackLapse {
  last_visit: string;
  visits_60d: number;
  median_gap_days: number;
  overdue_days: number;
  days_since: number;
  usual_program: string | null;
  /** Identifies this lapse; stored as the candidate's trigger_event_id. */
  trigger_key: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The player's lapse as of `today`, or null when they are not a lapsing regular today. */
export function evaluateWinbackLapse(visits: WinbackVisit[], today: string): WinbackLapse | null {
  const days = [...new Set(visits.map((visit) => visit.date).filter((date) => date <= today))].sort();
  if (!days.length) return null;
  const last = days[days.length - 1];
  const window60 = days.filter((date) => date >= addCalendarDays(last, -60));
  if (window60.length < WINBACK_MIN_VISITS_60D) return null;
  const window90 = days.filter((date) => date >= addCalendarDays(last, -90));
  const gaps = window90.slice(1).map((date, index) => calendarDayDistance(date, window90[index]));
  if (!gaps.length) return null;
  const medianGap = median(gaps);
  const overdue = Math.max(WINBACK_MIN_OVERDUE_DAYS, Math.ceil(2 * medianGap));
  if (overdue > WINBACK_MAX_DAYS_SINCE) return null;
  const daysSince = calendarDayDistance(today, last);
  if (daysSince < overdue || daysSince > WINBACK_MAX_DAYS_SINCE) return null;

  // Usual program: most visits in the 60-day window; ties go to the most recent.
  const counts = new Map<string, { count: number; latest: string }>();
  for (const visit of visits) {
    const name = visit.program?.trim();
    if (!name || visit.date < addCalendarDays(last, -60) || visit.date > last) continue;
    const entry = counts.get(name) ?? { count: 0, latest: "" };
    entry.count++;
    if (visit.date > entry.latest) entry.latest = visit.date;
    counts.set(name, entry);
  }
  const usual = [...counts.entries()].sort((a, b) =>
    b[1].count - a[1].count || b[1].latest.localeCompare(a[1].latest) || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  return {
    last_visit: last,
    visits_60d: window60.length,
    median_gap_days: medianGap,
    overdue_days: overdue,
    days_since: daysSince,
    usual_program: usual,
    trigger_key: `lapse:${last}`,
  };
}

export interface WinbackSession {
  name: string;
  start_time: string;
  signup_url: string;
}

/** "6pm" / "6:30pm" in New York time. */
export function winbackClockTime(startTime: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(new Date(startTime));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  const period = (parts.find((part) => part.type === "dayPeriod")?.value ?? "").toLowerCase();
  return `${hour}${minute === "00" ? "" : `:${minute}`}${period}`;
}

/** "today at 6pm", "tomorrow at 6pm" or "on Tuesday at 6pm", relative to the send date. */
export function winbackWhenPhrase(startTime: string, sendDate: string): string {
  const eventDate = toEtDate(startTime);
  const offset = calendarDayDistance(eventDate, sendDate) * (eventDate >= sendDate ? 1 : -1);
  const day = offset === 0 ? "today" : offset === 1 ? "tomorrow" : `on ${retentionWeekday(eventDate)}`;
  return `${day} at ${winbackClockTime(startTime)}`;
}

/** Is this session one the text may name, for a text sent at `sendAt`? */
export function isWinbackSessionUsable(startTime: string, sendAt: Date): boolean {
  const start = Date.parse(startTime);
  if (!Number.isFinite(start) || start < sendAt.getTime() + WINBACK_SESSION_MIN_LEAD_MS) return false;
  const offset = calendarDayDistance(toEtDate(startTime), toEtDate(sendAt));
  return toEtDate(startTime) >= toEtDate(sendAt) && offset <= WINBACK_SESSION_HORIZON_DAYS;
}

export const WINBACK_SESSION_TEMPLATES = [
  "Hi {first}, it's PB Club. {program} has open spots {when} if you want to get back out there. Book here: {url}",
  "Hi {first}, it's PB Club. There's room in {program} {when} if you're up for a game. You can book here: {url}",
  "Hi {first}, it's PB Club. We've got spots left in {program} {when}. Grab one here if you'd like to play: {url}",
] as const;

export const WINBACK_GENERIC_TEMPLATES = [
  "Hi {first}, it's PB Club. It's been a little while since your last game. Here's the schedule if you want to get back out: {url}",
  "Hi {first}, it's PB Club. Here's this week's schedule if you're up for a game soon: {url}",
] as const;

export function winbackTemplateIndex(seed: string, count: number): number {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % count;
}

export interface BuiltWinbackText {
  body: string;
  template: "session" | "generic";
  template_index: number;
  when: string | null;
}

export function buildWinbackText(args: {
  firstName: string;
  session: WinbackSession | null;
  sendDate: string;
  bookingUrl: string;
  seed: string;
}): BuiltWinbackText {
  const fill = (template: string, facts: Record<string, string>) =>
    template.replace(/\{(\w+)\}/g, (_, key: string) => facts[key] ?? "");
  if (args.session) {
    const index = winbackTemplateIndex(args.seed, WINBACK_SESSION_TEMPLATES.length);
    const when = winbackWhenPhrase(args.session.start_time, args.sendDate);
    return {
      body: fill(WINBACK_SESSION_TEMPLATES[index], {
        first: args.firstName, program: args.session.name.trim(), when, url: args.session.signup_url,
      }),
      template: "session", template_index: index, when,
    };
  }
  const index = winbackTemplateIndex(args.seed, WINBACK_GENERIC_TEMPLATES.length);
  return {
    body: fill(WINBACK_GENERIC_TEMPLATES[index], { first: args.firstName, url: args.bookingUrl }),
    template: "generic", template_index: index, when: null,
  };
}

const PROMO_LANGUAGE = /(?:\b\d+(?:\.\d+)?\s*%|\b\d+\s+percent\b|\b(?:discount|promo|coupon|free|complimentary|save|savings|offer|deal|code)\w*|\$\s?\d)/i;

/**
 * Checks any win-back body (template-built or operator-edited) before approval.
 * Allowed links: the named session's signup URL, or the booking page.
 */
export function validateWinbackText(
  body: string,
  context: { player_first_name: string; next_program?: { signup_url: string } | null; booking_url?: string },
): string[] {
  const text = body.trim();
  const errors: string[] = [];
  const opener = `Hi ${context.player_first_name.trim()}, it's PB Club.`;
  if (!context.player_first_name.trim()) errors.push("Player first name is missing");
  if (!text.startsWith(opener)) errors.push(`Message must open exactly with "${opener}"`);
  if (/[–—]/u.test(text)) errors.push("Message must not contain em or en dashes");
  if (text.includes("!")) errors.push("Message must not contain exclamation points");
  if (PROMO_LANGUAGE.test(text)) errors.push("Win-back texts carry no promotion or price language");
  if ([...text].length > 320) errors.push("Message must be 320 characters or fewer");
  const allowed = new Set([context.next_program?.signup_url, context.booking_url]
    .filter((url): url is string => !!url).map((url) => url.replace(/[),.;!?]+$/g, "")));
  const urls = text.match(/(?:https?:\/\/|www\.)[^\s<>"']+/gi) ?? [];
  if (!urls.length) errors.push("Message must include the booking link");
  for (const raw of urls) {
    if (!allowed.has(raw.replace(/[),.;!?]+$/g, ""))) errors.push("Message includes a link that is not in the draft's facts");
  }
  return [...new Set(errors)];
}

export interface WinbackContactHistory {
  /** Sent outbound texts (any flow) in the last 30 days, newest first, ISO timestamps. */
  sent_at: string[];
}

export function winbackContactBlock(history: WinbackContactHistory, now: Date): string | null {
  const cooldownStart = now.getTime() - WINBACK_CONTACT_COOLDOWN_DAYS * 86_400_000;
  const windowStart = now.getTime() - 30 * 86_400_000;
  const sent = history.sent_at.map((value) => Date.parse(value)).filter(Number.isFinite);
  if (sent.some((time) => time >= cooldownStart)) return "texted_in_last_7_days";
  if (sent.filter((time) => time >= windowStart).length >= WINBACK_MAX_TEXTS_30D) return "two_texts_in_last_30_days";
  return null;
}

export function winbackHoldoutBucket(playerId: string, triggerKey: string): number {
  return winbackTemplateIndex(`${playerId}:${WINBACK_PLAYBOOK_KEY}:${triggerKey}`, 10_000);
}

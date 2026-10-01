import { supabase } from "./supabaseClient";
import { validateRetentionCoupon, type RetentionCouponValidation } from "./retentionCoupons";
import { toEtDate } from "./retentionDates";
import {
  RETENTION_LTP_VERIFIED_OFFER_TEXT,
  RETENTION_NO_PROGRAM_BOOKING_URL,
} from "./retentionTypes";
import type { RetentionContext, RetentionNextProgram, RetentionPlaybook } from "./retentionTypes";

export const normalizeRetentionName = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/[\u2010-\u2015_-]/g, " ").replace(/\s+/g, " ").trim();

export const isLearnToPlayName = (value: string) =>
  /\blearn to play\b/.test(normalizeRetentionName(value));

const timeET = (value: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(value));

interface LiveEvent extends Record<string, any> {
  id: string;
  name: string;
  startTime: string;
  status?: string;
  isCanceled?: boolean;
  totalTeams?: number;
}

interface LiveSignup {
  status?: string;
  owner?: { id?: string | null } | null;
}

export type RetentionContextFailureReason = "no_next_program" | "context_lookup_failed";

export interface RetentionLookupDiagnostics {
  status: "pending" | "ok" | "error" | "skipped" | "no_match" | "not_applicable";
  errors: string[];
}

export interface RetentionContextDiagnostics extends Record<string, unknown> {
  player_id: string;
  upcoming: {
    window_start: string;
    window_end: string;
    requests: { method: "GET"; url: string; page: number }[];
    raw_event_count: number;
    in_window_event_count: number;
    published_in_window_event_count: number;
    matched_next_program_names: string[];
    unmatched_next_program_names: string[];
    filter_causes: {
      unpublished_or_canceled_count: number;
      outside_client_window_count: number;
      matching_event_count: number;
      missing_total_teams_event_ids: string[];
      full_event_ids: string[];
    };
  };
  lookups: {
    next_program: RetentionLookupDiagnostics;
    classmate: RetentionLookupDiagnostics;
    already_booked: RetentionLookupDiagnostics;
  };
}

export class RetentionContextError extends Error {
  readonly reason: RetentionContextFailureReason;
  readonly errors: string[];
  readonly diagnostics: RetentionContextDiagnostics;

  constructor(
    reason: RetentionContextFailureReason,
    errors: string[],
    diagnostics: RetentionContextDiagnostics,
  ) {
    super(errors.join("; "));
    this.name = "RetentionContextError";
    this.reason = reason;
    this.errors = errors;
    this.diagnostics = diagnostics;
  }
}

export const RETENTION_UPCOMING_DAYS = 14;
const PAGE_SIZE = 100;
const SIGNUP_BATCH_SIZE = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetentionEventWindow {
  start: Date;
  end: Date;
}

export function getRetentionEventWindow(
  now: Date = new Date(),
  daysAhead = RETENTION_UPCOMING_DAYS,
): RetentionEventWindow {
  return {
    start: new Date(now.getTime()),
    end: new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000),
  };
}

export function isRetentionEventWithinWindow(
  startTime: string,
  window: RetentionEventWindow,
): boolean {
  const start = Date.parse(startTime);
  return Number.isFinite(start) && start > window.start.getTime() && start <= window.end.getTime();
}

export function countConfirmedRetentionSignups(signups: LiveSignup[]): number {
  return signups.filter((signup) => String(signup.status ?? "").toUpperCase() === "CONFIRMED").length;
}

export function calculateRetentionOpenSpots(totalTeams: unknown, signups: LiveSignup[]): number | null {
  if (
    totalTeams === null
    || totalTeams === undefined
    || typeof totalTeams === "boolean"
    || (typeof totalTeams === "string" && !totalTeams.trim())
    || (typeof totalTeams !== "number" && typeof totalTeams !== "string")
  ) {
    return null;
  }
  const capacity = Number(totalTeams);
  if (!Number.isInteger(capacity) || capacity < 0) return null;
  return capacity - countConfirmedRetentionSignups(signups);
}

const isActiveRetentionSignup = (signup: LiveSignup) =>
  !["CANCELED", "DRAFT"].includes(String(signup.status ?? "").toUpperCase());

interface UpcomingEventsResult {
  events: LiveEvent[];
  rawEventNames: string[];
  requestUrls: string[];
  rawEventCount: number;
  inWindowEventCount: number;
  publishedInWindowEventCount: number;
  window: RetentionEventWindow;
}

interface UpcomingEventsCacheEntry {
  promise: Promise<UpcomingEventsResult>;
  window: RetentionEventWindow;
  rawEventNames: string[];
  requestUrls: string[];
  rawEventCount: number;
  inWindowEventCount: number;
  publishedInWindowEventCount: number;
}

interface SignupCacheEntry {
  promise: Promise<LiveSignup[]>;
}

const upcomingContextCaches = new WeakMap<
  Map<string, Promise<any[]>>,
  Map<string, UpcomingEventsCacheEntry>
>();
const signupDetailCaches = new WeakMap<
  Map<string, Promise<string[]>>,
  Map<string, SignupCacheEntry>
>();

export interface RetentionLiveClub {
  base: string;
  apiKey: string;
  timezone: string;
}

export async function loadLiveClub(clubId: string): Promise<RetentionLiveClub> {
  const { data: club, error } = await supabase.from("clubs")
    .select("platform_api_key, platform_subdomain, timezone").eq("id", clubId).maybeSingle();
  if (error || !club?.platform_subdomain) throw new Error(`Could not load PodPlay configuration for club: ${error?.message ?? "missing subdomain"}`);
  const apiKey = club.platform_api_key ?? process.env.PODPLAY_API_KEY;
  if (!apiKey) throw new Error("PodPlay API key is not configured");
  return { base: `https://${club.platform_subdomain}.podplay.app`, apiKey, timezone: club.timezone ?? "America/New_York" };
}

export function loadLiveClubCached(
  clubId: string,
  cache: Map<string, Promise<RetentionLiveClub>>,
): Promise<RetentionLiveClub> {
  let club = cache.get(clubId);
  if (!club) {
    club = loadLiveClub(clubId);
    cache.set(clubId, club);
  }
  return club;
}

export interface VerifiedRetentionTrigger {
  date: string;
  name: string;
  start_time: string;
}

export async function verifyRetentionTriggerEvent(
  clubId: string,
  eventId: string,
  clubCache: Map<string, Promise<RetentionLiveClub>>,
  eventCache: Map<string, Promise<VerifiedRetentionTrigger>>,
): Promise<VerifiedRetentionTrigger> {
  const key = `${clubId}:${eventId}`;
  let pending = eventCache.get(key);
  if (!pending) {
    pending = (async () => {
      const club = await loadLiveClubCached(clubId, clubCache);
      const response = await fetch(`${club.base}/apis/v2/events/${encodeURIComponent(eventId)}`, {
        headers: { "x-api-key": club.apiKey },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`PodPlay GET /events/${eventId} returned ${response.status}`);
      const payload = await response.json() as any;
      const event = payload.item ?? payload.event ?? payload;
      if (!event || (event.id && String(event.id) !== eventId) || typeof event.startTime !== "string" || typeof event.name !== "string") {
        throw new Error(`PodPlay event ${eventId} response lacks verifiable name/startTime`);
      }
      if (event.isCanceled === true) throw new Error(`PodPlay trigger event ${eventId} is canceled`);
      return { date: toEtDate(event.startTime), name: event.name, start_time: event.startTime };
    })();
    eventCache.set(key, pending);
  }
  return pending;
}

/** Context construction uses live signup state; no attendee names are retained. */
export async function buildRetentionContext(args: {
  clubId: string;
  player: { id: string; name: string; external_id: string | null };
  playbook: RetentionPlaybook;
  trigger: { event_id: string; name: string; date: string };
  classmatesExternalIds: string[] | (() => Promise<string[]>);
  socialEventsCache: Map<string, Promise<any[]>>;
  socialSignupsCache: Map<string, Promise<string[]>>;
  clubCache: Map<string, Promise<RetentionLiveClub>>;
  couponCache: Map<string, Promise<RetentionCouponValidation>>;
}): Promise<RetentionContext> {
  const { clubId, player, playbook, trigger, classmatesExternalIds, socialEventsCache, socialSignupsCache, clubCache, couponCache } = args;
  const diagnostics: RetentionContextDiagnostics = {
    player_id: player.id,
    upcoming: {
      window_start: "",
      window_end: "",
      requests: [],
      raw_event_count: 0,
      in_window_event_count: 0,
      published_in_window_event_count: 0,
      matched_next_program_names: [],
      unmatched_next_program_names: [...playbook.next_program_names],
      filter_causes: {
        unpublished_or_canceled_count: 0,
        outside_client_window_count: 0,
        matching_event_count: 0,
        missing_total_teams_event_ids: [],
        full_event_ids: [],
      },
    },
    lookups: {
      next_program: { status: "pending", errors: [] },
      classmate: { status: "pending", errors: [] },
      already_booked: { status: "pending", errors: [] },
    },
  };
  const failContextLookup = (messages: string[]): never => {
    for (const lookup of Object.values(diagnostics.lookups)) {
      if (lookup.status === "pending") lookup.status = "error";
      if (lookup.status === "error") lookup.errors.push(...messages);
    }
    throw new RetentionContextError("context_lookup_failed", messages, diagnostics);
  };

  let live!: RetentionLiveClub;
  try {
    live = await loadLiveClubCached(clubId, clubCache);
  } catch (error) {
    failContextLookup([`Could not load live PodPlay configuration: ${safeErrorMessage(error)}`]);
  }

  if (!player.external_id) {
    diagnostics.lookups.next_program.status = "skipped";
    diagnostics.lookups.classmate.status = "skipped";
    diagnostics.lookups.already_booked.status = "error";
    const errors = [`Player ${player.id} has no PodPlay external_id; upcoming bookings cannot be verified`];
    diagnostics.lookups.already_booked.errors.push(...errors);
    throw new RetentionContextError("context_lookup_failed", errors, diagnostics);
  }

  let upcoming!: UpcomingEventsResult;
  try {
    upcoming = await loadRetentionUpcomingEvents({
      clubId,
      live,
      cache: socialEventsCache,
    });
    copyUpcomingDiagnostics(diagnostics, upcoming);
  } catch (error) {
    const failedLookup = getUpcomingCache(socialEventsCache).get(clubId);
    if (failedLookup) copyUpcomingDiagnostics(diagnostics, failedLookup);
    failContextLookup([`Upcoming events lookup failed: ${safeErrorMessage(error)}`]);
  }

  let signupsByEvent: Map<string, LiveSignup[]>;
  try {
    signupsByEvent = await loadRetentionSignupsForEvents(
      upcoming.events,
      live,
      socialSignupsCache,
    );
  } catch (error) {
    const message = `Live signup lookup failed: ${safeErrorMessage(error)}`;
    for (const lookup of Object.values(diagnostics.lookups)) {
      lookup.status = "error";
      lookup.errors.push(message);
    }
    throw new RetentionContextError("context_lookup_failed", [message], diagnostics);
  }

  const orderedEvents = [...upcoming.events].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const booking = orderedEvents.find((event) =>
    (signupsByEvent.get(event.id) ?? [])
      .filter(isActiveRetentionSignup)
      .some((signup) => signup.owner?.id === player.external_id));
  const bookedEvent = booking ? {
    event_id: booking.id, name: booking.name, start_time: booking.startTime,
    date: toEtDate(booking.startTime), time: timeET(booking.startTime),
    signup_url: `${live.base}/community/events/${booking.id}`,
  } : null;
  diagnostics.lookups.already_booked.status = "ok";

  const normalizedConfiguredNames = new Map<string, string>();
  for (const configuredName of playbook.next_program_names) {
    const normalized = normalizeRetentionName(configuredName);
    if (normalized) normalizedConfiguredNames.set(normalized, configuredName);
  }
  const nameMatchedEvents = orderedEvents.filter((event) =>
    normalizedConfiguredNames.has(normalizeRetentionName(event.name)));
  diagnostics.upcoming.matched_next_program_names = [...new Set(nameMatchedEvents.map((event) => event.name))];
  diagnostics.upcoming.filter_causes.matching_event_count = nameMatchedEvents.length;
  diagnostics.upcoming.unmatched_next_program_names = [...normalizedConfiguredNames.entries()]
    .filter(([normalized]) => !nameMatchedEvents.some((event) => normalizeRetentionName(event.name) === normalized))
    .map(([, configuredName]) => configuredName);

  let next_program: RetentionNextProgram | null = null;
  let classmates_signed_up = 0;
  for (const event of nameMatchedEvents) {
    const signups = signupsByEvent.get(event.id) ?? [];
    const spots = calculateRetentionOpenSpots(event.totalTeams, signups);
    if (spots === null) {
      diagnostics.upcoming.filter_causes.missing_total_teams_event_ids.push(event.id);
      continue;
    }
    if (spots <= 0) {
      diagnostics.upcoming.filter_causes.full_event_ids.push(event.id);
      continue;
    }
    const eventDate = toEtDate(event.startTime);
    next_program = {
      event_id: event.id, name: event.name, start_time: event.startTime,
      date: eventDate, time: timeET(event.startTime),
      signup_url: `${live.base}/community/events/${event.id}`, spots_remaining: spots,
    };
    break;
  }

  if (!next_program && diagnostics.upcoming.filter_causes.missing_total_teams_event_ids.length) {
    const message = "A matching next program has missing or invalid capacity, so availability could not be verified";
    diagnostics.lookups.next_program.status = "error";
    diagnostics.lookups.next_program.errors.push(message);
    throw new RetentionContextError("context_lookup_failed", [message], diagnostics);
  }

  if (next_program) {
    diagnostics.lookups.next_program.status = "ok";
    try {
      const externalIds = typeof classmatesExternalIds === "function"
        ? await classmatesExternalIds()
        : classmatesExternalIds;
      const signups = signupsByEvent.get(next_program.event_id) ?? [];
      const activeIds = new Set(signups
        .filter(isActiveRetentionSignup)
        .map((signup) => signup.owner?.id ?? "")
        .filter(Boolean));
      classmates_signed_up = [...new Set(externalIds)].filter((id) => activeIds.has(id)).length;
      diagnostics.lookups.classmate.status = "ok";
    } catch (error) {
      const message = `Classmate lookup failed: ${safeErrorMessage(error)}`;
      diagnostics.lookups.classmate.status = "error";
      diagnostics.lookups.classmate.errors.push(message);
      throw new RetentionContextError("context_lookup_failed", [message], diagnostics);
    }
  } else {
    diagnostics.lookups.next_program.status = "no_match";
    diagnostics.lookups.classmate.status = "not_applicable";
  }

  const variant = next_program ? "with_program" : "no_program";
  const isNoProgramLtp = variant === "no_program" && playbook.key === "ltp_followup";
  const couponCode = isNoProgramLtp ? "LTPNEXT25" : playbook.promo_code;
  const offerText = isNoProgramLtp ? RETENTION_LTP_VERIFIED_OFFER_TEXT : playbook.offer_text;
  let promo: RetentionContext["promo"] = null;
  let coupon_warning: string | null = null;
  if (couponCode && (isNoProgramLtp || offerText)) {
    const couponKey = `${clubId}:${couponCode}`;
    let couponPromise = couponCache.get(couponKey);
    if (!couponPromise) {
      couponPromise = validateRetentionCoupon(clubId, couponCode);
      couponCache.set(couponKey, couponPromise);
    }
    try {
      const coupon = await couponPromise;
      if (coupon.valid && (!bookedEvent || !next_program)) {
        promo = { code: couponCode, offer_text: offerText! };
      } else coupon_warning = coupon.warning;
    } catch (error) {
      coupon_warning = `Could not verify coupon ${couponCode}: ${safeErrorMessage(error)}`;
    }
  }
  const forbiddenProgramNames = variant === "no_program"
    ? [...new Set([
      trigger.name,
      ...playbook.next_program_names,
      ...upcoming.rawEventNames,
    ].map((name) => name.trim()).filter(Boolean))]
    : undefined;
  return {
    variant,
    trigger,
    player_first_name: player.name.trim().split(/\s+/)[0],
    next_program,
    ...(variant === "no_program" ? {
      booking_url: RETENTION_NO_PROGRAM_BOOKING_URL,
      forbidden_program_names: forbiddenProgramNames,
    } : {}),
    classmates_signed_up,
    already_booked: !!bookedEvent,
    booked_event: bookedEvent,
    promo,
    coupon_warning,
    evaluated_at: new Date().toISOString(),
    diagnostics,
  };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getUpcomingCache(
  cache: Map<string, Promise<any[]>>,
): Map<string, UpcomingEventsCacheEntry> {
  let entries = upcomingContextCaches.get(cache);
  if (!entries) {
    entries = new Map<string, UpcomingEventsCacheEntry>();
    upcomingContextCaches.set(cache, entries);
  }
  return entries;
}

function getSignupCache(
  cache: Map<string, Promise<string[]>>,
): Map<string, SignupCacheEntry> {
  let entries = signupDetailCaches.get(cache);
  if (!entries) {
    entries = new Map<string, SignupCacheEntry>();
    signupDetailCaches.set(cache, entries);
  }
  return entries;
}

function copyUpcomingDiagnostics(
  diagnostics: RetentionContextDiagnostics,
  upcoming: UpcomingEventsResult | UpcomingEventsCacheEntry,
): void {
  diagnostics.upcoming.window_start = upcoming.window.start.toISOString();
  diagnostics.upcoming.window_end = upcoming.window.end.toISOString();
  diagnostics.upcoming.requests = upcoming.requestUrls.map((url, index) => ({
    method: "GET",
    url,
    page: index + 1,
  }));
  diagnostics.upcoming.raw_event_count = upcoming.rawEventCount;
  diagnostics.upcoming.in_window_event_count = upcoming.inWindowEventCount;
  diagnostics.upcoming.published_in_window_event_count = upcoming.publishedInWindowEventCount;
  diagnostics.upcoming.filter_causes.outside_client_window_count = Math.max(
    0,
    upcoming.rawEventCount - upcoming.inWindowEventCount,
  );
  diagnostics.upcoming.filter_causes.unpublished_or_canceled_count = Math.max(
    0,
    upcoming.inWindowEventCount - upcoming.publishedInWindowEventCount,
  );
}

async function loadRetentionUpcomingEvents(args: {
  clubId: string;
  live: RetentionLiveClub;
  cache: Map<string, Promise<any[]>>;
}): Promise<UpcomingEventsResult> {
  const { clubId, live, cache } = args;
  const entries = getUpcomingCache(cache);
  let entry = entries.get(clubId);
  if (!entry) {
    const window = getRetentionEventWindow();
    const requestUrls: string[] = [];
    const mutableEntry: UpcomingEventsCacheEntry = {
      promise: Promise.resolve(null as unknown as UpcomingEventsResult),
      window,
      rawEventNames: [],
      requestUrls,
      rawEventCount: 0,
      inWindowEventCount: 0,
      publishedInWindowEventCount: 0,
    };
    let promise!: Promise<UpcomingEventsResult>;
    promise = (async () => {
      const rawEvents: LiveEvent[] = [];
      for (let page = 1; page <= 100; page++) {
        const url = `${live.base}/apis/v2/events?startTime=${encodeURIComponent(window.start.toISOString())}&endTime=${encodeURIComponent(window.end.toISOString())}&page=${page}&ipp=${PAGE_SIZE}`;
        requestUrls.push(url);
        const response = await fetch(url, {
          headers: { "x-api-key": live.apiKey },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`PodPlay GET /events page ${page} returned ${response.status}`);
        let payload: any;
        try {
          payload = await response.json();
        } catch {
          throw new Error(`PodPlay GET /events page ${page} returned invalid JSON`);
        }
        if (!Array.isArray(payload?.items)) {
          throw new Error(`PodPlay GET /events page ${page} response did not include an items array`);
        }
        const items = payload.items as LiveEvent[];
        if (items.some((event) =>
          !event
          || typeof event.id !== "string"
          || typeof event.name !== "string"
          || typeof event.startTime !== "string"
          || !Number.isFinite(Date.parse(event.startTime)),
        )) {
          throw new Error(`PodPlay GET /events page ${page} included an event without a valid id, name, or startTime`);
        }
        rawEvents.push(...items);
        mutableEntry.rawEventNames = rawEvents.map((event) => event.name);
        mutableEntry.rawEventCount = rawEvents.length;
        mutableEntry.inWindowEventCount = rawEvents
          .filter((event) => isRetentionEventWithinWindow(event.startTime, window)).length;
        mutableEntry.publishedInWindowEventCount = rawEvents
          .filter((event) =>
            isRetentionEventWithinWindow(event.startTime, window)
            && !event.isCanceled
            && event.status === "PUBLISHED",
          ).length;
        const hasMore = payload.hasMore === true
          || Number(payload.totalPages ?? 0) > page
          || (payload.total && page * PAGE_SIZE < Number(payload.total));
        if (!hasMore && items.length < PAGE_SIZE) break;
        if (page === 100) throw new Error("PodPlay GET /events exceeded pagination safety limit");
      }
      const inWindow = rawEvents.filter((event) => isRetentionEventWithinWindow(event.startTime, window));
      const publishedInWindow = inWindow
        .filter((event) => !event.isCanceled && event.status === "PUBLISHED")
        .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
      return {
        events: publishedInWindow,
        rawEventNames: [...mutableEntry.rawEventNames],
        requestUrls: [...requestUrls],
        rawEventCount: rawEvents.length,
        inWindowEventCount: inWindow.length,
        publishedInWindowEventCount: publishedInWindow.length,
        window,
      };
    })();
    mutableEntry.promise = promise;
    entry = mutableEntry;
    entries.set(clubId, entry);
  }
  return entry.promise;
}

async function fetchRetentionEventSignups(
  live: RetentionLiveClub,
  event: LiveEvent,
): Promise<LiveSignup[]> {
  const signups: LiveSignup[] = [];
  for (let page = 1; page <= 100; page++) {
    const url = `${live.base}/apis/v2/events/${encodeURIComponent(event.id)}/signups?page=${page}&ipp=${PAGE_SIZE}`;
    const response = await fetch(url, {
      headers: { "x-api-key": live.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`PodPlay GET /events/${event.id}/signups page ${page} returned ${response.status}`);
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`PodPlay GET /events/${event.id}/signups page ${page} returned invalid JSON`);
    }
    if (!Array.isArray(payload?.items)) {
      throw new Error(`PodPlay GET /events/${event.id}/signups page ${page} response did not include an items array`);
    }
    const items = payload.items as LiveSignup[];
    signups.push(...items);
    const hasMore = payload.hasMore === true
      || Number(payload.totalPages ?? 0) > page
      || (payload.total && page * PAGE_SIZE < Number(payload.total));
    if (!hasMore && items.length < PAGE_SIZE) break;
    if (page === 100) throw new Error(`PodPlay signups for event ${event.id} exceeded pagination safety limit`);
  }
  return signups;
}

async function loadRetentionSignupsForEvents(
  events: LiveEvent[],
  live: RetentionLiveClub,
  cache: Map<string, Promise<string[]>>,
): Promise<Map<string, LiveSignup[]>> {
  const detailsCache = getSignupCache(cache);
  const results = new Map<string, LiveSignup[]>();
  for (let offset = 0; offset < events.length; offset += SIGNUP_BATCH_SIZE) {
    const batch = events.slice(offset, offset + SIGNUP_BATCH_SIZE);
    const hasUncachedSignups = batch.some((event) => !detailsCache.has(event.id));
    if (offset > 0 && hasUncachedSignups) await sleep(250);
    const batchResults = await Promise.all(batch.map(async (event) => {
      let entry = detailsCache.get(event.id);
      if (!entry) {
        const promise = fetchRetentionEventSignups(live, event);
        entry = { promise };
        detailsCache.set(event.id, entry);
      }
      return { eventId: event.id, signups: await entry.promise };
    }));
    for (const result of batchResults) results.set(result.eventId, result.signups);
  }
  return results;
}
import { supabase } from "./supabaseClient";
import { getPlayerSocialContext } from "./socialGraph";
import { validateRetentionCoupon, type RetentionCouponValidation } from "./retentionCoupons";
import { toEtDate } from "./retentionDates";
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
}

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
  classmatesExternalIds: string[];
  socialEventsCache: Map<string, Promise<any[]>>;
  socialSignupsCache: Map<string, Promise<string[]>>;
  clubCache: Map<string, Promise<RetentionLiveClub>>;
  couponCache: Map<string, Promise<RetentionCouponValidation>>;
}): Promise<RetentionContext> {
  const { clubId, player, playbook, trigger, classmatesExternalIds, socialEventsCache, socialSignupsCache, clubCache, couponCache } = args;
  const social = await getPlayerSocialContext(player.id, {
    clubId, strict: true, daysAhead: 36500,
    liveEventsCache: socialEventsCache, liveSignupsCache: socialSignupsCache,
  });
  const booked = social.registrations[0] ?? null;
  const live = await loadLiveClubCached(clubId, clubCache);
  const events = await socialEventsCache.get(clubId);
  if (!events) throw new Error("Strict live PodPlay event context was not cached");
  events.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const bookedEvent = booked ? {
    event_id: booked.event_id, name: booked.event_name, start_time: booked.start_time,
    date: toEtDate(booked.start_time), time: timeET(booked.start_time),
    signup_url: `${live.base}/community/events/${booked.event_id}`,
  } : null;

  let next_program: RetentionNextProgram | null = null;
  let classmates_signed_up = 0;
  const names = new Set(playbook.next_program_names.map(normalizeRetentionName));
  const horizon = Date.now() + 10 * 24 * 60 * 60 * 1000;
  if (!bookedEvent) {
    for (const event of events) {
      const start = Date.parse(event.startTime);
      if (start <= Date.now() || start > horizon || !names.has(normalizeRetentionName(event.name))) continue;
      let activeIds = socialSignupsCache.get(event.id);
      if (!activeIds) throw new Error(`Live signup state missing for event ${event.id}`);
      const signupIds = await activeIds;
      const attendees = new Set(signupIds.filter(Boolean));
      const capacity = Number(event.guests?.max ?? event.capacity ?? event.maximumCapacity ?? event.maxParticipants ?? event.admissionRate?.capacity);
      if (!Number.isFinite(capacity) || capacity <= 0) continue;
      const spots = capacity - signupIds.length;
      if (spots <= 0) continue;
      const eventDate = toEtDate(event.startTime);
      next_program = {
        event_id: event.id, name: event.name, start_time: event.startTime,
        date: eventDate, time: timeET(event.startTime),
        signup_url: `${live.base}/community/events/${event.id}`, spots_remaining: spots,
      };
      classmates_signed_up = [...new Set(classmatesExternalIds)].filter((id) => attendees.has(id)).length;
      break;
    }
  }

  let promo: RetentionContext["promo"] = null;
  let coupon_warning: string | null = null;
  if (playbook.promo_code && playbook.offer_text) {
    const couponKey = `${clubId}:${playbook.promo_code}`;
    let couponPromise = couponCache.get(couponKey);
    if (!couponPromise) {
      couponPromise = validateRetentionCoupon(clubId, playbook.promo_code);
      couponCache.set(couponKey, couponPromise);
    }
    const coupon = await couponPromise;
    if (coupon.valid && !bookedEvent) promo = { code: playbook.promo_code, offer_text: playbook.offer_text };
    else coupon_warning = coupon.warning;
  }
  return {
    trigger,
    player_first_name: player.name.trim().split(/\s+/)[0],
    next_program,
    classmates_signed_up,
    already_booked: !!bookedEvent,
    booked_event: bookedEvent,
    promo,
    coupon_warning,
    evaluated_at: new Date().toISOString(),
  };
}
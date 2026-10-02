import { supabase } from "./supabaseClient";
import { validateRetentionCoupon } from "./retentionCoupons";
import {
  calculateRetentionOpenSpots,
  isLearnToPlayName,
  loadLiveClubCached,
  type RetentionLiveClub,
} from "./retentionContext";
import { RetentionPodplayBatchClient } from "./retentionPodplayBatch";
import { toEtDate } from "./retentionDates";
import type { RetentionCandidate } from "./retentionTypes";

export interface LtpBookingBatchOptions {
  client?: RetentionPodplayBatchClient;
  clubCache?: Map<string, Promise<RetentionLiveClub>>;
  eventsCache?: Map<string, Promise<any[]>>;
  signupsCache?: Map<string, Promise<string[]>>;
}

export interface LtpBookedExit {
  booked_event_id: string;
  source: "podplay_upcoming_signup" | "attendances";
}

const PAGE_LIMIT = 100;
const EVENT_LIST_PAGE_SIZE = 500;
const SIGNUP_PAGE_SIZE = 100;
const ALL_FUTURE_EVENTS_END = "9999-12-31T23:59:59.999Z";
const CANCELLED_SIGNUP_STATUSES = new Set(["CANCELED", "CANCELLED", "DRAFT"]);

function failClosed(message: string): never {
  throw new Error(`LTP sequence eligibility could not be verified: ${message}`);
}

function assertValidCutoff(cutoffISO: string): void {
  if (!cutoffISO.trim() || !Number.isFinite(Date.parse(cutoffISO))) {
    failClosed("booking cutoff is missing or invalid");
  }
}

function isFutureSession(value: unknown, now: number): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  return Date.parse(value) > now;
}

async function loadLtpUpcomingEvents(
  clubId: string,
  live: RetentionLiveClub,
  options: LtpBookingBatchOptions,
): Promise<any[]> {
  const cache = options.eventsCache;
  const key = `ltp-all-upcoming:${clubId}`;
  let promise = cache?.get(key);
  if (!promise) {
    const now = Date.now();
    const startTime = new Date(now).toISOString();
    promise = (async () => {
      const events: any[] = [];
      for (let page = 1; page <= PAGE_LIMIT; page++) {
        const url =
          `${live.base}/apis/v2/events?startTime=${encodeURIComponent(startTime)}` +
          `&endTime=${encodeURIComponent(ALL_FUTURE_EVENTS_END)}&page=${page}&ipp=${EVENT_LIST_PAGE_SIZE}`;
        const response = await (options.client ?? defaultBatchClient).fetch(url, {
          headers: { "x-api-key": live.apiKey },
          requestTimeoutMs: 15_000,
        });
        if (!response.ok) {
          failClosed(`PodPlay upcoming event listing returned ${response.status}`);
        }
        let payload: any;
        try {
          payload = await response.json();
        } catch {
          failClosed("PodPlay upcoming event listing returned invalid JSON");
        }
        if (!Array.isArray(payload?.items)) {
          failClosed("PodPlay upcoming event listing is missing its items array");
        }
        const rows = payload.items as any[];
        if (rows.some((event) =>
          !event
          || typeof event.id !== "string"
          || typeof event.startTime !== "string"
          || !Number.isFinite(Date.parse(event.startTime))
          || typeof event.name !== "string"
        )) {
          failClosed("PodPlay upcoming event listing contains an invalid event");
        }
        if (rows.length > EVENT_LIST_PAGE_SIZE) {
          failClosed("PodPlay upcoming event listing exceeded its requested page size");
        }
        if (payload.hasMore !== undefined && typeof payload.hasMore !== "boolean") {
          failClosed("PodPlay upcoming event listing has invalid pagination metadata");
        }
        for (const field of ["totalPages", "total"] as const) {
          if (payload[field] !== undefined) {
            const rawValue = payload[field];
            if (
              (typeof rawValue !== "number" && typeof rawValue !== "string")
              || (typeof rawValue === "string" && !rawValue.trim())
            ) {
              failClosed("PodPlay upcoming event listing has invalid pagination metadata");
            }
            const value = Number(rawValue);
            if (!Number.isSafeInteger(value) || value < 0) {
              failClosed("PodPlay upcoming event listing has invalid pagination metadata");
            }
          }
        }
        events.push(...rows.filter((event) =>
          isFutureSession(event.startTime, now)
          && event.status === "PUBLISHED"
          && event.isCanceled !== true,
        ));
        const hasMore = payload.hasMore === true
          || Number(payload.totalPages ?? 0) > page
          || (payload.total && page * EVENT_LIST_PAGE_SIZE < Number(payload.total));
        if (!hasMore && rows.length < EVENT_LIST_PAGE_SIZE) return events;
        if (page === PAGE_LIMIT) failClosed("PodPlay event listing exceeded the pagination safety limit");
      }
      failClosed("PodPlay event listing exceeded the pagination safety limit");
    })();
    if (cache) {
      cache.set(key, promise);
      const cached = promise;
      void promise.catch(() => {
        if (cache.get(key) === cached) cache.delete(key);
      });
    }
  }
  return promise;
}

async function fetchEventSignups(
  clubId: string,
  live: RetentionLiveClub,
  eventId: string,
  options: LtpBookingBatchOptions,
): Promise<any[]> {
  const cache = options.signupsCache;
  const key = `ltp-all-upcoming:${clubId}:${eventId}`;
  let promise = cache?.get(key);
  if (!promise) {
    promise = (async () => {
      const signups: any[] = [];
      for (let page = 1; page <= PAGE_LIMIT; page++) {
        const url = `${live.base}/apis/v2/events/${encodeURIComponent(eventId)}/signups?page=${page}&ipp=${SIGNUP_PAGE_SIZE}`;
        const response = await (options.client ?? defaultBatchClient).fetch(url, {
          headers: { "x-api-key": live.apiKey },
          requestTimeoutMs: 10_000,
        });
        if (!response.ok) failClosed(`PodPlay signup lookup for event ${eventId} returned ${response.status}`);
        let payload: any;
        try {
          payload = await response.json();
        } catch {
          failClosed(`PodPlay signup lookup for event ${eventId} returned invalid JSON`);
        }
        if (!Array.isArray(payload?.items)) failClosed(`PodPlay signup lookup for event ${eventId} is missing its items array`);
        const rows = payload.items as any[];
        if (rows.length > SIGNUP_PAGE_SIZE) {
          failClosed(`PodPlay signup lookup for event ${eventId} exceeded its requested page size`);
        }
        if (payload.hasMore !== undefined && typeof payload.hasMore !== "boolean") {
          failClosed(`PodPlay signup lookup for event ${eventId} has invalid pagination metadata`);
        }
        for (const field of ["totalPages", "total"] as const) {
          if (payload[field] !== undefined) {
            const rawValue = payload[field];
            if (
              (typeof rawValue !== "number" && typeof rawValue !== "string")
              || (typeof rawValue === "string" && !rawValue.trim())
            ) {
              failClosed(`PodPlay signup lookup for event ${eventId} has invalid pagination metadata`);
            }
            const value = Number(rawValue);
            if (!Number.isSafeInteger(value) || value < 0) {
              failClosed(`PodPlay signup lookup for event ${eventId} has invalid pagination metadata`);
            }
          }
        }
        signups.push(...rows);
        const hasMore = payload.hasMore === true
          || Number(payload.totalPages ?? 0) > page
          || (payload.total && page * SIGNUP_PAGE_SIZE < Number(payload.total));
        if (!hasMore && rows.length < SIGNUP_PAGE_SIZE) return signups;
        if (page === PAGE_LIMIT) failClosed(`PodPlay signup lookup for event ${eventId} exceeded the pagination safety limit`);
      }
      failClosed(`PodPlay signup lookup for event ${eventId} exceeded the pagination safety limit`);
    })();
    if (cache) {
      cache.set(key, promise);
      const cached = promise;
      void promise.catch(() => {
        if (cache.get(key) === cached) cache.delete(key);
      });
    }
  }
  return promise;
}

async function findPodplayBooking(
  clubId: string,
  playerExternalId: string,
  cutoffMs: number,
  options: LtpBookingBatchOptions,
): Promise<LtpBookedExit | null> {
  const clubCache = options.clubCache ?? new Map<string, Promise<RetentionLiveClub>>();
  let live: RetentionLiveClub;
  try {
    live = await loadLiveClubCached(clubId, clubCache);
  } catch (error) {
    failClosed(error instanceof Error ? error.message : String(error));
  }
  const events = await loadLtpUpcomingEvents(clubId, live!, options);
  for (const event of events) {
    if (Date.parse(event.startTime) <= cutoffMs) continue;
    const signups = await fetchEventSignups(clubId, live!, event.id, options);
    const playerBooked = signups.some((signup) =>
      signup?.owner?.id != null
      && String(signup.owner.id) === playerExternalId
      && !CANCELLED_SIGNUP_STATUSES.has(String(signup.status ?? "").trim().toUpperCase()),
    );
    if (playerBooked) return { booked_event_id: event.id, source: "podplay_upcoming_signup" };
  }
  return null;
}

const defaultBatchClient = new RetentionPodplayBatchClient();

/**
 * Check both of the authoritative booking sources before either sequence step
 * is sent. Any failed/incomplete lookup throws instead of authorizing dispatch.
 */
export async function checkLtpBookingSince(
  clubId: string,
  playerId: string,
  cutoffISO: string,
  batchOptions: LtpBookingBatchOptions = {},
): Promise<LtpBookedExit | null> {
  assertValidCutoff(cutoffISO);
  const cutoff = Date.parse(cutoffISO);
  const { data: player, error: playerError } = await supabase.from("players")
    .select("id,external_id,club_id").eq("id", playerId).eq("club_id", clubId).maybeSingle();
  if (playerError) failClosed(`player identity lookup failed: ${playerError.message}`);
  if (!player || player.club_id !== clubId) failClosed("player does not belong to this club");
  if (typeof player.external_id !== "string" || !player.external_id.trim()) {
    failClosed("player has no verified PodPlay external ID");
  }

  const { data: attendances, error: attendanceError } = await supabase.from("attendances")
    .select("event_id,attended_at")
    .eq("player_id", playerId)
    .gt("attended_at", cutoffISO)
    .order("attended_at", { ascending: true })
    .limit(1);
  if (attendanceError) failClosed(`attendance-history lookup failed: ${attendanceError.message}`);
  if (attendances?.length) {
    const firstAttendance = attendances[0];
    if (
      typeof firstAttendance.event_id !== "string"
      || !firstAttendance.event_id.trim()
      || typeof firstAttendance.attended_at !== "string"
      || !Number.isFinite(Date.parse(firstAttendance.attended_at))
      || Date.parse(firstAttendance.attended_at) <= cutoff
    ) {
      failClosed("recent attendance exists but its booked event ID or timestamp is missing");
    }
  }
  const attendance = attendances?.[0];
  if (attendance) return { booked_event_id: attendance.event_id, source: "attendances" };

  return findPodplayBooking(clubId, player.external_id.trim(), cutoff, batchOptions);
}

export async function verifyLtpSequenceSchemaReady(): Promise<void> {
  const { data, error } = await supabase.rpc("retention_sequence_ready");
  if (error || data !== true) {
    failClosed(`migration 013 is not installed or ready${error?.message ? `: ${error.message}` : ""}`);
  }
}

export async function transitionLtpSequence(
  clubId: string,
  playerId: string,
  playbookKey: "ltp_followup",
  status: "paused_reply" | "exited_booked" | "exited_opt_out" | "completed",
  reason: string,
  bookedEventId: string | null = null,
): Promise<unknown> {
  if (status === "exited_booked" && !bookedEventId?.trim()) {
    throw new Error("A booked event ID is required to record the LTP booked exit");
  }
  const { data, error } = await supabase.rpc("retention_sequence_transition", {
    p_club_id: clubId,
    p_player_id: playerId,
    p_playbook_key: playbookKey,
    p_status: status,
    p_reason: reason,
    p_booked_event_id: bookedEventId,
  });
  if (error || !data) {
    throw new Error(`Could not record LTP sequence ${status} transition: ${error?.message ?? "no sequence returned"}`);
  }
  return data;
}

export class SmsOptOutPersistenceError extends Error {
  constructor(
    message: string,
    readonly playerOptOutPersisted: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SmsOptOutPersistenceError";
  }
}

/**
 * Persist the provider-authoritative opt-out before attempting the LTP
 * transition. A transition failure must never roll back or prevent the player
 * flag from being stored; callers should surface it and let the provider retry.
 */
export async function permanentlyOptOutPlayerAndExitLtpSequence(
  playerId: string,
  clubId: string | null | undefined,
  reason: string,
): Promise<void> {
  const { data: updatedPlayer, error: playerError } = await supabase
    .from("players")
    .update({ opted_out: true, sms_opt_in: false })
    .eq("id", playerId)
    .select("id")
    .maybeSingle();
  if (playerError || !updatedPlayer?.id) {
    throw new SmsOptOutPersistenceError(
      `Could not persist the player's SMS opt-out: ${playerError?.message ?? "player was not found"}`,
      false,
    );
  }

  if (!clubId) {
    throw new SmsOptOutPersistenceError(
      "Player SMS opt-out was persisted, but the player's club could not be resolved for LTP sequence exit",
      true,
    );
  }

  try {
    await transitionLtpSequence(clubId, playerId, "ltp_followup", "exited_opt_out", reason);
  } catch (error) {
    // Players without an LTP sequence need no sequence transition. All other
    // errors (including migration readiness failures) stay visible to callers.
    if (error instanceof Error && /LTP sequence not found/i.test(error.message)) return;
    throw new SmsOptOutPersistenceError(
      `Player SMS opt-out was persisted, but the LTP sequence could not be permanently exited: ${error instanceof Error ? error.message : String(error)}`,
      true,
      { cause: error },
    );
  }
}

export async function applyTwilio21610OptOut(playerId: string, reason: string): Promise<void> {
  const { data: player, error } = await supabase
    .from("players")
    .select("id,club_id")
    .eq("id", playerId)
    .maybeSingle();
  if (error || !player?.id) {
    throw new SmsOptOutPersistenceError(
      `Could not resolve the player for Twilio opt-out code 21610: ${error?.message ?? "player was not found"}`,
      false,
    );
  }
  await permanentlyOptOutPlayerAndExitLtpSequence(player.id, player.club_id, reason);
}

export async function recordLtpSequenceSend(
  clubId: string,
  messageId: string,
  deliveryKind: "real" | "test" | "simulated",
): Promise<unknown> {
  const { data, error } = await supabase.rpc("retention_sequence_record_send", {
    p_club_id: clubId,
    p_message_id: messageId,
    p_delivery_kind: deliveryKind,
  });
  if (error || !data) {
    throw new Error(`Could not record persisted LTP ${deliveryKind} delivery: ${error?.message ?? "no sequence returned"}`);
  }
  return data;
}

/**
 * Promote an LTP send to a real delivery only after Twilio confirms delivery
 * and the contact ledger proves the original player's number was used.
 */
export async function confirmLtpRecipientDelivery(messageId: string): Promise<boolean> {
  const { data: candidate, error: candidateError } = await supabase.from("retention_candidates")
    .select("playbook_key,club_id,player_id")
    .eq("message_id", messageId).maybeSingle();
  if (candidateError) throw new Error(`Could not resolve LTP sequence for delivered message: ${candidateError.message}`);
  if (candidate?.playbook_key !== "ltp_followup") return false;

  const { data: message, error: messageError } = await supabase.from("messages")
    .select("status,delivery_status,delivered_at,retention_delivery_kind")
    .eq("id", messageId).maybeSingle();
  if (messageError || !message) throw new Error(`Could not verify delivered LTP message: ${messageError?.message ?? "message is missing"}`);
  if (
    message.status !== "sent"
    || message.delivery_status !== "delivered"
    || !message.delivered_at
    || message.retention_delivery_kind === "test"
    || message.retention_delivery_kind === "simulated"
  ) return false;

  const { data: ledger, error: ledgerError } = await supabase.from("contact_ledger")
    .select("is_test,player_id,intended_player_id")
    .eq("message_id", messageId).limit(1).maybeSingle();
  if (ledgerError) throw new Error(`Could not verify LTP recipient contact ledger: ${ledgerError.message}`);
  if (
    !ledger
    || ledger.is_test !== false
    || (ledger.player_id !== candidate.player_id && ledger.intended_player_id !== candidate.player_id)
  ) return false;

  if (message.retention_delivery_kind !== "real") {
    const { data: updated, error: deliveryUpdateError } = await supabase.from("messages")
      .update({ retention_delivery_kind: "real" })
      .eq("id", messageId)
      .is("retention_delivery_kind", null)
      .select("id")
      .maybeSingle();
    if (deliveryUpdateError) throw new Error(`Could not persist confirmed LTP recipient delivery: ${deliveryUpdateError.message}`);
    if (!updated) {
      // A concurrent provider callback may have done the same idempotent write.
      const { data: current, error: currentError } = await supabase.from("messages")
        .select("retention_delivery_kind")
        .eq("id", messageId).maybeSingle();
      if (currentError || current?.retention_delivery_kind !== "real") {
        return false;
      }
    }
  }

  await recordLtpSequenceSend(candidate.club_id, messageId, "real");
  return true;
}

export async function returnLtpSequenceForSessionReview(
  clubId: string,
  candidateId: string,
  expectedClaimedAt: string | null,
  sessionChange?: LtpSequenceDispatchCheck["sessionChange"],
  previousLtpText?: RetentionCandidate["context"]["ltp_text"],
): Promise<unknown> {
  const { data, error } = await supabase.rpc("retention_sequence_session_changed", {
    p_club_id: clubId,
    p_candidate_id: candidateId,
    p_expected_claimed_at: expectedClaimedAt,
  });
  if (error || !data) {
    throw new Error(`Could not return the changed LTP session for review: ${error?.message ?? "no candidate returned"}`);
  }
  if (!sessionChange) return data;

  const returnedCandidate = data as Record<string, any>;
  const returnedContext = returnedCandidate.context;
  if (
    returnedCandidate.id !== candidateId
    || returnedCandidate.status !== "drafted"
    || typeof returnedCandidate.updated_at !== "string"
    || !returnedContext
    || typeof returnedContext !== "object"
    || returnedContext.reason !== "session_changed"
  ) {
    throw new Error("Could not verify the session-review candidate returned by the database");
  }

  const nextContext = {
    ...returnedContext,
    ...(previousLtpText ? { ltp_text: previousLtpText } : {}),
    session_change: sessionChange,
  };
  const { data: updated, error: updateError } = await supabase.from("retention_candidates")
    .update({ context: nextContext })
    .eq("id", candidateId)
    .eq("club_id", clubId)
    .eq("status", "drafted")
    .eq("updated_at", returnedCandidate.updated_at)
    .eq("context", JSON.stringify(returnedContext))
    .select("id,context,updated_at")
    .maybeSingle();
  if (updateError || !updated) {
    throw new Error(`Could not persist session-change diagnostics without overwriting a concurrent edit: ${updateError?.message ?? "candidate changed after session review"}`);
  }
  return { ...returnedCandidate, context: updated.context, updated_at: updated.updated_at };
}

export async function stepOneRealSentAt(
  candidate: Pick<RetentionCandidate, "club_id" | "sequence_id" | "step">,
): Promise<string> {
  if (!candidate.sequence_id) failClosed("candidate has no shared sequence identity");
  const { data: sequence, error: sequenceError } = await supabase.from("retention_sequences")
    .select("sequence_status,step1_sent_at,step1_delivery_kind")
    .eq("id", candidate.sequence_id).eq("club_id", candidate.club_id).maybeSingle();
  if (sequenceError || !sequence) {
    failClosed(`shared LTP sequence lookup failed: ${sequenceError?.message ?? "sequence is missing"}`);
  }
  if (sequence.sequence_status !== "active" || sequence.step1_delivery_kind !== "real" || !sequence.step1_sent_at) {
    failClosed("step 2 requires an active sequence and a confirmed real step-1 delivery");
  }
  const { data: stepOne, error } = await supabase.from("retention_candidates")
    .select("id,message_id,step,sequence_id").eq("club_id", candidate.club_id)
    .eq("sequence_id", candidate.sequence_id).eq("step", 1).maybeSingle();
  if (error || !stepOne?.message_id) failClosed(`step 1 message lookup failed: ${error?.message ?? "message is missing"}`);
  const { data: message, error: messageError } = await supabase.from("messages")
    .select("status,sent_at,simulated,retention_delivery_kind")
    .eq("id", stepOne.message_id).maybeSingle();
  if (messageError || !message) failClosed(`step 1 send verification failed: ${messageError?.message ?? "message is missing"}`);
  if (
    message.status !== "sent"
    || !message.sent_at
    || message.simulated !== false
    || message.retention_delivery_kind !== "real"
  ) {
    failClosed("step 2 requires an actual recipient delivery of step 1");
  }
  return sequence.step1_sent_at as string;
}

export interface LtpSequenceDispatchCheck {
  valid: boolean;
  reason: "session_changed" | null;
  booked: LtpBookedExit | null;
  cutoff: string;
  sessionChange?: {
    old_start_time: string;
    new_start_time: string;
    reason: "start_time_changed" | "canceled" | "full" | "event_changed";
  };
}

async function checkSuggestedEventAtDispatch(
  candidate: RetentionCandidate,
  program: NonNullable<RetentionCandidate["context"]["next_program"]>,
  live: RetentionLiveClub,
  options: LtpBookingBatchOptions,
  cutoff: string,
): Promise<LtpSequenceDispatchCheck | null> {
  const oldStartTime = program.start_time;
  if (typeof oldStartTime !== "string" || !Number.isFinite(Date.parse(oldStartTime))) {
    failClosed("the approved next-program start time is missing or invalid");
  }

  let response: Response;
  try {
    response = await (options.client ?? defaultBatchClient).fetch(
      `${live.base}/apis/v2/events/${encodeURIComponent(program.event_id)}`,
      { headers: { "x-api-key": live.apiKey }, requestTimeoutMs: 12_000 },
    );
  } catch (error) {
    failClosed(`suggested-event lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response!.ok) failClosed(`suggested-event lookup returned ${response!.status}`);

  let payload: any;
  try {
    payload = await response!.json();
  } catch {
    failClosed("suggested-event lookup returned invalid JSON");
  }
  const event = payload?.item ?? payload?.event ?? payload;
  if (
    !event
    || typeof event.id !== "string"
    || event.id !== program.event_id
    || typeof event.name !== "string"
    || typeof event.startTime !== "string"
    || !Number.isFinite(Date.parse(event.startTime))
    || typeof event.status !== "string"
    || (event.isCanceled !== undefined && typeof event.isCanceled !== "boolean")
  ) {
    failClosed("suggested-event lookup returned an incomplete or invalid event");
  }

  const newStartTime = event.startTime as string;
  const sessionChange = (
    reason: NonNullable<LtpSequenceDispatchCheck["sessionChange"]>["reason"],
  ): LtpSequenceDispatchCheck => ({
    valid: false,
    reason: "session_changed",
    booked: null,
    cutoff,
    sessionChange: {
      old_start_time: oldStartTime,
      new_start_time: newStartTime,
      reason,
    },
  });

  if (
    event.isCanceled === true
    || ["CANCELED", "CANCELLED"].includes(event.status.trim().toUpperCase())
    || event.status.trim().toUpperCase() !== "PUBLISHED"
  ) {
    return sessionChange("canceled");
  }
  if (event.name !== program.name) return sessionChange("event_changed");

  const signupOptions = { ...options, signupsCache: new Map<string, Promise<any[]>>() };
  const signups = await fetchEventSignups(candidate.club_id, live, program.event_id, signupOptions);
  if (signups.some((signup) => !signup || typeof signup !== "object" || typeof signup.status !== "string")) {
    failClosed("suggested-event signup lookup contains an invalid signup");
  }
  const spotsRemaining = calculateRetentionOpenSpots(event.totalTeams, signups);
  if (spotsRemaining === null) failClosed("suggested-event lookup is missing valid capacity");
  if (spotsRemaining < 1) return sessionChange("full");
  if (newStartTime !== oldStartTime) return sessionChange("start_time_changed");
  if (program.signup_url !== `${live.base}/community/events/${event.id}`) return sessionChange("event_changed");
  return null;
}

/** Reverify the stored session facts and offer against the live provider. */
export async function recheckLtpSequenceDispatch(
  candidate: RetentionCandidate,
  batchOptions: LtpBookingBatchOptions = {},
  approvedMessageBody?: string | null,
): Promise<LtpSequenceDispatchCheck> {
  batchOptions = {
    ...batchOptions,
    clubCache: batchOptions.clubCache ?? new Map<string, Promise<RetentionLiveClub>>(),
    eventsCache: batchOptions.eventsCache ?? new Map<string, Promise<any[]>>(),
    signupsCache: batchOptions.signupsCache ?? new Map<string, Promise<string[]>>(),
  };
  const context = candidate.context as RetentionCandidate["context"] & Record<string, any>;
  const marker = context?.ltp_text;
  if ((candidate.step !== 1 && candidate.step !== 2) || marker?.step !== candidate.step) {
    failClosed("the candidate lacks its matching step marker; legacy LTP copy cannot send");
  }
  if (!candidate.sequence_id || candidate.sequence_status !== "active") {
    failClosed("the sequence is missing or is not active");
  }

  let cutoff: string;
  if (candidate.step === 1) {
    const { data: trigger, error } = await supabase.from("attendances")
      .select("attended_at").eq("player_id", candidate.player_id)
      .eq("event_id", candidate.trigger_event_id).maybeSingle();
    if (error || !trigger?.attended_at) failClosed(`Learn to Play trigger attendance is missing: ${error?.message ?? "no attendance"}`);
    cutoff = trigger.attended_at;
    // A contemporaneous PodPlay detail confirms the trigger is still the same
    // event and gives a precise, source-backed step-1 booking cutoff.
    const clubCache = batchOptions.clubCache ?? new Map<string, Promise<RetentionLiveClub>>();
    const live = await loadLiveClubCached(candidate.club_id, clubCache);
    const response = await (batchOptions.client ?? defaultBatchClient).fetch(
      `${live.base}/apis/v2/events/${encodeURIComponent(candidate.trigger_event_id)}`,
      { headers: { "x-api-key": live.apiKey }, requestTimeoutMs: 12_000 },
    );
    if (!response.ok) failClosed(`LTP trigger verification returned ${response.status}`);
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      failClosed("LTP trigger verification returned invalid JSON");
    }
    const event = payload?.item ?? payload?.event ?? payload;
    if (
      !event
      || (event.id && String(event.id) !== candidate.trigger_event_id)
      || typeof event.startTime !== "string"
      || !Number.isFinite(Date.parse(event.startTime))
      || !isLearnToPlayName(String(event.name ?? ""))
      || event.isCanceled === true
    ) {
      failClosed("the original Learn to Play trigger is canceled or could not be verified");
    }
    cutoff = event.startTime;
  } else {
    cutoff = await stepOneRealSentAt(candidate);
  }

  const booked = await checkLtpBookingSince(candidate.club_id, candidate.player_id, cutoff, batchOptions);
  if (booked) return { valid: false, reason: null, booked, cutoff };

  const program = context.next_program;
  if (program) {
    if (
      typeof program.event_id !== "string"
      || typeof program.signup_url !== "string"
      || typeof program.name !== "string"
      || typeof program.start_time !== "string"
    ) {
      failClosed("the approved next-program facts are incomplete");
    }
    const clubCache = batchOptions.clubCache ?? new Map<string, Promise<RetentionLiveClub>>();
    const live = await loadLiveClubCached(candidate.club_id, clubCache);
    const sessionCheck = await checkSuggestedEventAtDispatch(candidate, program, live, batchOptions, cutoff);
    if (sessionCheck) return sessionCheck;
  } else if (context.variant !== "no_program") {
    failClosed("the candidate is missing its reviewed next-program assignment");
  }

  if (candidate.step === 1) {
    const code = context.promo?.code;
    if (code !== "LTPNEXT25") {
      failClosed("step 1 does not contain the verified LTPNEXT25 offer");
    }
    const validation = await validateRetentionCoupon(candidate.club_id, code, (input, init) =>
      (batchOptions.client ?? defaultBatchClient).fetch(input, init),
    );
    if (!validation.valid) failClosed(validation.warning ?? "LTPNEXT25 is no longer valid");
  } else {
    const bodyText = JSON.stringify({
      context: context.ltp_text,
      promo: context.promo,
      next_program: context.next_program?.name ?? null,
    });
    if (
      context.promo != null
      || /\bLTPNEXT25\b|\b\d+(?:\.\d+)?\s*(?:%|percent\b)|\bdiscount\b|\bsave\s+\d/i.test(bodyText)
    ) {
      failClosed("step 2 contains a prohibited promotion fact");
    }
    if (
      typeof approvedMessageBody !== "string"
      || /\bLTPNEXT25\b|\b\d+(?:\.\d+)?\s*(?:%|percent\b)|\bdiscount\b|\bcoupon\b|\bpromo(?:tional)?(?:\s+code)?\b|\buse\s+code\b|\bsave\s+\d/i.test(approvedMessageBody)
    ) {
      failClosed("approved step-2 copy contains a prohibited offer, code, or percentage");
    }
  }

  return { valid: true, reason: null, booked: null, cutoff };
}
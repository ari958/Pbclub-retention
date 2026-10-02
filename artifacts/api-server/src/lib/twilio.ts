import twilio from "twilio";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import { isRetentionOnlyMode, isTextEligible, requiresMarketingConsent } from "./retentionPolicy";
import { isInsideSendWindow } from "./playerTiming";
import { supabase } from "./supabaseClient";
import { validateRetentionCoupon } from "./retentionCoupons";
import { verifyRetentionCandidateDispatch } from "./retentionDispatch";
import { DispatchAudit } from "./dispatchAudit";
import {
  confirmLtpRecipientDelivery,
  applyTwilio21610OptOut,
  recheckLtpSequenceDispatch,
  recordLtpSequenceSend,
  returnLtpSequenceForSessionReview,
  transitionLtpSequence,
  type LtpBookingBatchOptions,
} from "./ltpSequenceLifecycle";

export function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  }
  return twilio(accountSid, authToken);
}

let testClientFactory: (() => ReturnType<typeof twilio>) | undefined;
let testClock: (() => Date) | undefined;
let testLtpBatchOptionsFactory: (() => LtpBookingBatchOptions) | undefined;

/** Test-only transport seam; production callers cannot override Twilio. */
export function setTwilioClientFactoryForTests(factory: (() => ReturnType<typeof twilio>) | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Twilio test transport can only be configured under NODE_ENV=test");
  }
  testClientFactory = factory ?? undefined;
}

export function setTwilioClockForTests(clock: (() => Date) | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Twilio test clock can only be configured under NODE_ENV=test");
  }
  testClock = clock ?? undefined;
}

/** Test-only PodPlay fixture seam; live dispatch uses the shared production client. */
export function setLtpSequenceBatchOptionsFactoryForTests(
  factory: (() => LtpBookingBatchOptions) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("LTP sequence test fixtures can only be configured under NODE_ENV=test");
  }
  testLtpBatchOptionsFactory = factory ?? undefined;
}

const currentTime = () => testClock ? testClock() : new Date();

const ltpBatchOptionsForDispatch = (): LtpBookingBatchOptions =>
  testLtpBatchOptionsFactory ? testLtpBatchOptionsFactory() : {};

/**
 * Send an SMS via Twilio (live) or log a dry-run (when SMS_LIVE !== "true").
 *
 * Every dispatch is bound to an approved, immutable message row. A successful
 * claim is deliberately retained after errors: a caller must reconcile an
 * ambiguous dispatch rather than automatically retrying it.
 */
export interface SendContext {
  messageId: string;
  source?: string;
  purpose?: string;
  experimentId?: string;
  bookingOptions?: LtpBookingBatchOptions;
}

export class SmsPolicyBlockedError extends Error {
  readonly code = "SMS_POLICY_BLOCKED";

  constructor(message: string, readonly sequenceAlreadyExited = false) {
    super(message);
    this.name = "SmsPolicyBlockedError";
  }
}

export class SmsDispatchClaimError extends Error {
  readonly code = "SMS_DISPATCH_CLAIM_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "SmsDispatchClaimError";
  }
}

export class SmsDispatchClaimedError extends Error {
  readonly code = "SMS_DISPATCH_CLAIMED";

  constructor(
    message: string,
    readonly messageId: string,
    readonly claimToken: string,
    cause?: unknown,
    readonly sequenceClaimedAt?: string,
    readonly playerId?: string,
    readonly clubId?: string | null,
  ) {
    super(message, { cause });
    this.name = "SmsDispatchClaimedError";
  }
}

export function isSmsPolicyBlockedError(error: unknown): error is SmsPolicyBlockedError {
  return error instanceof SmsPolicyBlockedError;
}

export function isSmsDispatchClaimError(error: unknown): error is SmsDispatchClaimError {
  return error instanceof SmsDispatchClaimError;
}

export function getSmsDispatchClaim(error: unknown): {
  messageId: string;
  claimToken: string;
  sequenceClaimedAt?: string;
  playerId?: string;
  clubId?: string | null;
} | null {
  return error instanceof SmsDispatchClaimedError
    ? {
        messageId: error.messageId,
        claimToken: error.claimToken,
        ...(error.sequenceClaimedAt ? { sequenceClaimedAt: error.sequenceClaimedAt } : {}),
        ...(error.playerId ? { playerId: error.playerId } : {}),
        ...(error.clubId !== undefined ? { clubId: error.clubId } : {}),
      }
    : null;
}

function twilioErrorCode(error: unknown): string | undefined {
  if (typeof error === "string" || typeof error === "number") return String(error).trim();
  const seen = new Set<unknown>();
  let current: any = error;
  let code: string | undefined;
  while (current && (typeof current === "object" || typeof current === "function") && !seen.has(current)) {
    seen.add(current);
    if (current.code !== undefined && current.code !== null) code = String(current.code).trim();
    current = current.cause;
  }
  return code;
}

export function isTwilio21610(error: unknown): boolean {
  return twilioErrorCode(error) === "21610";
}

export async function recordSmsDispatchFailure(error: unknown): Promise<boolean> {
  const claim = getSmsDispatchClaim(error);
  if (!claim) return false;
  const code = twilioErrorCode(error);

  let failureQuery = supabase
    .from("messages")
    .update({
      status: "failed",
      error_code: code,
      error_message: error instanceof Error ? error.message : "Unknown dispatch error",
    })
    .eq("id", claim.messageId)
    .eq("status", "pending");
  failureQuery = claim.sequenceClaimedAt
    ? failureQuery.eq("dispatch_claimed_at", claim.sequenceClaimedAt).is("dispatch_token", null)
    : failureQuery.eq("dispatch_token", claim.claimToken);
  const { data, error: updateError } = await failureQuery.select("id").maybeSingle();

  if (updateError) {
    logger.error({ messageId: claim.messageId, err: updateError.message }, "Could not record failed SMS dispatch");
  }
  if (isTwilio21610(error)) {
    if (!claim.playerId) {
      throw new Error("Twilio 21610 was received, but the claimed message has no resolved player for opt-out");
    }
    await applyTwilio21610OptOut(claim.playerId, "twilio_error_21610");
  }
  if (updateError) return false;
  return !!data;
}

export function composeApprovedMessageBody(body: string, signupUrl?: string | null): string {
  return signupUrl ? `${body}\n${signupUrl}` : body;
}

export async function sendViaTwilio(
  to: string,
  body: string,
  context?: SendContext,
): Promise<{ sid: string; simulated: boolean; isTest?: boolean }> {
  const audit = new DispatchAudit(context?.messageId ?? "missing");
  try {
    const result = await sendApprovedMessage(to, body, context, audit);
    audit.end("pass");
    return result;
  } catch (error) {
    audit.end(isSmsPolicyBlockedError(error) || isSmsDispatchClaimError(error) ? "blocked" : "error",
      { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Shared fail-closed gate, also used before each queue message. */
export async function assertSmsKillSwitchOff(clubId: string): Promise<void> {
  try {
    const { data, error } = await supabase.from("clubs").select("sms_kill_switch").eq("id", clubId).maybeSingle();
    if (error || !data || data.sms_kill_switch !== false) {
      throw new SmsPolicyBlockedError(`SMS kill switch blocked dispatch: ${error?.message ?? "engaged or unavailable"}`);
    }
  } catch (error) {
    if (isSmsPolicyBlockedError(error)) throw error;
    throw new SmsPolicyBlockedError(`SMS kill switch blocked dispatch; read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertFinalTransportAllowed(clubId: string, audit: DispatchAudit): Promise<void> {
  audit.begin("kill_switch_final");
  await assertSmsKillSwitchOff(clubId);
  audit.begin("send_window_final");
  if (!isInsideSendWindow(currentTime())) {
    throw new SmsPolicyBlockedError("SMS dispatch is outside the TCPA send window immediately before transport");
  }
  audit.end("pass");
}

async function sendApprovedMessage(
  to: string, body: string, context: SendContext | undefined, audit: DispatchAudit,
): Promise<{ sid: string; simulated: boolean; isTest?: boolean }> {
  audit.begin("approval");
  if (!context?.messageId?.trim()) {
    throw new Error("SMS dispatch requires an approved messageId context");
  }

  const { data: message, error: messageError } = await supabase
    .from("messages")
    .select("id, body, signup_url, approved_at, approved_by, approved_body, status, player_id, conversation_id, dispatch_claimed_at, dispatch_token")
    .eq("id", context.messageId)
    .maybeSingle();
  if (messageError || !message) {
    throw new Error(`Approved message could not be loaded: ${messageError?.message ?? "not found"}`);
  }
  if (
    message.status !== "pending" ||
    message.dispatch_claimed_at ||
    message.dispatch_token ||
    !message.approved_at ||
    typeof message.approved_by !== "string" ||
    !message.approved_by.trim() ||
    typeof message.approved_body !== "string" ||
    !message.approved_body.trim()
  ) {
    throw new Error("Message is not explicitly approved");
  }

  audit.begin("approved_body_match");
  const approvedBody = composeApprovedMessageBody(message.body ?? "", message.signup_url);
  if (approvedBody !== message.approved_body || body !== approvedBody) {
    throw new Error("Message body does not match its approved body");
  }

  audit.begin("player_eligibility");
  let playerId = message.player_id as string | null;
  if (!playerId && message.conversation_id) {
    const { data: conversation, error } = await supabase
      .from("conversations")
      .select("player_id")
      .eq("id", message.conversation_id)
      .maybeSingle();
    if (error || !conversation?.player_id) {
      throw new Error(`Message player could not be resolved: ${error?.message ?? "not found"}`);
    }
    playerId = conversation.player_id;
  }
  if (!playerId) throw new SmsPolicyBlockedError("Approved message has no player");

  const { data: player, error: playerError } = await supabase
    .from("players")
    .select("id, phone, opted_out, sms_opt_in, consent_source, sms_consented_at, club_id")
    .eq("id", playerId)
    .maybeSingle();
  if (playerError || !player) {
    throw new SmsPolicyBlockedError(`Message player could not be loaded: ${playerError?.message ?? "not found"}`);
  }
  if (!player.phone?.trim() || player.opted_out === true) {
    throw new SmsPolicyBlockedError("Player is not text eligible");
  }
  if (!isRetentionOnlyMode() && requiresMarketingConsent() && !isTextEligible(player)) {
    throw new SmsPolicyBlockedError("Player does not satisfy marketing-consent policy");
  }
  if (to.trim() !== player.phone.trim()) {
    throw new SmsPolicyBlockedError("SMS destination does not match the player's current phone");
  }
  audit.begin("retention_candidate");
  const retentionCandidate = await verifyRetentionCandidateDispatch(
    context.messageId,
    playerId,
    player.club_id,
    message.approved_at,
  );
  const ltpCandidate = retentionCandidate?.playbook_key === "ltp_followup"
    ? retentionCandidate as any
    : null;
  const promoCode = (retentionCandidate?.context as any)?.promo?.code;
  const bookingOptions = { ...(context.bookingOptions ?? ltpBatchOptionsForDispatch()), messageId: context.messageId };
  audit.begin("stale_flag");
  audit.end("pass", { stale: !!(retentionCandidate?.context as any)?.stale, policy: "operator-reviewed provenance; not a dispatch blocker" });

  audit.begin("send_window_preclaim");
  if (!isInsideSendWindow(currentTime())) {
    throw new SmsPolicyBlockedError("SMS dispatch is outside the TCPA send window");
  }

  audit.begin("kill_switch_preclaim");
  const { data: club, error: clubError } = await supabase
    .from("clubs")
    .select("sms_kill_switch")
    .eq("id", player.club_id)
    .maybeSingle();
  if (clubError || !club) {
    throw new SmsPolicyBlockedError(`SMS kill switch could not be verified: ${clubError?.message ?? "club not found"}`);
  }
  if (club.sms_kill_switch !== false) {
    throw new SmsPolicyBlockedError("SMS kill switch is engaged or unavailable");
  }

  const smsLive   = process.env.SMS_LIVE === "true";
  const overrideTo = (process.env.SMS_TEST_OVERRIDE_TO ?? "").trim();
  const effectiveTo = overrideTo || to;
  const isTest = !!overrideTo;
  const LEGACY_SMS_OVERRIDE_DIAGNOSTIC_PARKED = false;
  if (LEGACY_SMS_OVERRIDE_DIAGNOSTIC_PARKED && overrideTo) {
    logger.info({ messageId: context.messageId, isTest }, "[SMS OVERRIDE] legacy diagnostic (parked)");
  }
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  // TWILIO_PHONE_NUMBER is the canonical from-number env var.
  // clubs.twilio_number exists in the DB but is intentionally unused here;
  // per-club Twilio numbers are a future milestone.
  const from = process.env.TWILIO_PHONE_NUMBER;
  const statusCallbackUrl = process.env.PUBLIC_API_URL
    ? `${process.env.PUBLIC_API_URL}/api/messages/webhook/status`
    : undefined;

  if (smsLive) {
    audit.begin("ledger_schema");
    // Validate schema and credentials before claiming: these checks cannot
    // deliver an SMS and should not quarantine an otherwise approved draft.
    const { error: ledgerSchemaError } = await supabase
      .from("contact_ledger")
      .select("message_id,is_test,intended_player_id,player_id")
      .limit(0);
    if (ledgerSchemaError) {
      throw new Error(`Contact ledger is not ready for SMS dispatch: ${ledgerSchemaError.message}`);
    }
  }

  audit.begin("transport_configuration");
  const client = smsLive
    ? (testClientFactory ? testClientFactory() : getTwilioClient())
    : null;

  const claimToken = randomUUID();
  const claimedAt = currentTime().toISOString();
  let claimed: any;
  let claimError: any;
  if (ltpCandidate) {
    try {
      audit.begin("ltp_preclaim");
      const firstCheck = await recheckLtpSequenceDispatch(
        ltpCandidate,
        bookingOptions,
        message.approved_body,
      );
      if (firstCheck.booked) {
        await transitionLtpSequence(
          player.club_id,
          playerId,
          "ltp_followup",
          "exited_booked",
          "booking_since_step_trigger_or_real_send",
          firstCheck.booked.booked_event_id,
        );
        throw new SmsPolicyBlockedError("Player booked a session after this LTP step was triggered", true);
      }
      if (firstCheck.reason === "session_changed") {
        await returnLtpSequenceForSessionReview(
          ltpCandidate.club_id,
          ltpCandidate.id,
          null,
          firstCheck.sessionChange,
          ltpCandidate.context.ltp_text,
        );
        throw new SmsPolicyBlockedError("Approved LTP session changed; the draft was returned for review");
      }
    } catch (error) {
      if (error instanceof SmsPolicyBlockedError) throw error;
      throw new SmsPolicyBlockedError(
        `LTP sequence eligibility could not be verified immediately before claim: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    audit.begin("database_claim");
    const { data, error } = await supabase.rpc("retention_sequence_claim", {
      p_club_id: player.club_id,
      p_candidate_id: ltpCandidate.id,
      p_message_id: context.messageId,
      p_expected_body: message.body ?? "",
      p_claimed_at: claimedAt,
      p_expected_context: ltpCandidate.context,
      p_expected_updated_at: ltpCandidate.updated_at,
    });
    claimed = data;
    claimError = error;
  } else {
    audit.begin("database_claim");
    const { data, error } = await supabase
      .from("messages")
      .update({ dispatch_claimed_at: claimedAt, dispatch_token: claimToken })
      .eq("id", context.messageId)
      .eq("status", "pending")
      .eq("approved_at", message.approved_at)
      .eq("approved_by", message.approved_by)
      .eq("approved_body", message.approved_body)
      .is("dispatch_claimed_at", null)
      .is("dispatch_token", null)
      .select("id")
      .maybeSingle();
    claimed = data;
    claimError = error;
  }
  if (claimError || !claimed) {
    throw new SmsDispatchClaimError(`Message dispatch claim failed: ${claimError?.message ?? "message is no longer dispatchable"}`);
  }
  audit.end("pass", {
    claimed_at: claimedAt,
    claim_commit_observed_at: new Date().toISOString(),
    timestamp_semantics: "successful database commit acknowledgment, not the earlier in-memory claimedAt",
  });

  try {
    audit.begin("player_eligibility_final");
    const { data: finalPlayer, error: finalPlayerError } = await supabase
      .from("players")
      .select("phone, opted_out, sms_opt_in, consent_source, sms_consented_at")
      .eq("id", playerId)
      .maybeSingle();
    if (finalPlayerError || !finalPlayer || !finalPlayer.phone?.trim() || finalPlayer.opted_out === true) {
      throw new SmsPolicyBlockedError(`Player eligibility could not be verified immediately before SMS dispatch: ${finalPlayerError?.message ?? "ineligible or missing"}`);
    }
    if (finalPlayer.phone.trim() !== to.trim()) {
      throw new SmsPolicyBlockedError("Player phone changed before SMS dispatch");
    }
    if (!isRetentionOnlyMode() && requiresMarketingConsent() && !isTextEligible(finalPlayer)) {
      throw new SmsPolicyBlockedError("Player marketing-consent eligibility changed before SMS dispatch");
    }
    if (
      typeof promoCode === "string" && promoCode.trim()
      && !(ltpCandidate && ltpCandidate.step === 2)
    ) {
      audit.begin("coupon_final");
      let coupon;
      try {
        coupon = await validateRetentionCoupon(player.club_id, promoCode);
      } catch (error: any) {
        throw new SmsPolicyBlockedError(`Retention coupon ${promoCode} could not be verified: ${error?.message ?? "lookup failed"}`);
      }
      if (!coupon.valid) {
        throw new SmsPolicyBlockedError(coupon.warning ?? `Retention coupon ${promoCode} could not be verified`);
      }
    }
    audit.begin("send_window_before_booking");
    if (!isInsideSendWindow(currentTime())) {
      throw new SmsPolicyBlockedError("SMS dispatch crossed outside the TCPA send window");
    }
    audit.begin("kill_switch_before_booking");
    const { data: lastChanceClub, error: lastChanceError } = await supabase
      .from("clubs")
      .select("sms_kill_switch")
      .eq("id", player.club_id)
      .maybeSingle();
    if (lastChanceError || !lastChanceClub || lastChanceClub.sms_kill_switch !== false) {
      throw new SmsPolicyBlockedError(`SMS kill switch blocked dispatch: ${lastChanceError?.message ?? "engaged or unavailable"}`);
    }

    if (ltpCandidate) {
      let finalCheck;
      try {
        audit.begin("ltp_final");
        // Booking history may use the <5-minute tick snapshot. The suggested
        // event and its capacity are freshly fetched inside the second check.
        finalCheck = await recheckLtpSequenceDispatch(
          ltpCandidate,
          bookingOptions,
          message.approved_body,
        );
      } catch (error) {
        throw new SmsPolicyBlockedError(
          `LTP sequence eligibility could not be reverified immediately before transport: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (finalCheck.booked) {
        try {
          await transitionLtpSequence(
            player.club_id,
            playerId,
            "ltp_followup",
            "exited_booked",
            "booking_since_step_trigger_or_real_send",
            finalCheck.booked.booked_event_id,
          );
        } catch (error) {
          throw new SmsPolicyBlockedError(
            `LTP booking was found but its sequence exit could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw new SmsPolicyBlockedError("Player booked a session after this LTP step was triggered", true);
      }
      if (finalCheck.reason === "session_changed") {
        try {
          await returnLtpSequenceForSessionReview(
            ltpCandidate.club_id,
            ltpCandidate.id,
            claimedAt,
            finalCheck.sessionChange,
            ltpCandidate.context.ltp_text,
          );
        } catch (error) {
          throw new SmsPolicyBlockedError(
            `The LTP session changed but could not be returned for review: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw new SmsPolicyBlockedError("Approved LTP session changed; the draft was returned for review");
      }
    }

    if (!smsLive) {
      await assertFinalTransportAllowed(player.club_id, audit);
      logger.info({ messageId: context.messageId, isTest }, "[SMS DRY-RUN] approved dispatch simulated");
      const sentAt = currentTime().toISOString();
      const simulatedValues: Record<string, unknown> = {
        status: "sent",
        twilio_message_sid: "SIMULATED",
        simulated: true,
        sent_at: sentAt,
      };
      if (ltpCandidate) simulatedValues.retention_delivery_kind = "simulated";
      let updateQuery = supabase
        .from("messages")
        .update(simulatedValues)
        .eq("id", context.messageId)
        .eq("status", "pending");
      updateQuery = ltpCandidate
        ? updateQuery.eq("dispatch_claimed_at", claimedAt).is("dispatch_token", null)
        : updateQuery.eq("dispatch_token", claimToken);
      const { data: updated, error: updateError } = await updateQuery.select("id").maybeSingle();
      if (updateError || !updated) throw new Error(`Could not record simulated dispatch: ${updateError?.message ?? "claim no longer owns the pending message"}`);
      const { error: candidateError } = await supabase
        .from("retention_candidates")
        .update({ status: "sent", updated_at: sentAt })
        .eq("message_id", context.messageId)
        .eq("status", "approved");
      if (candidateError && !/does not exist|schema cache/i.test(candidateError.message)) {
        logger.error({ messageId: context.messageId, err: candidateError.message }, "Could not record linked retention candidate as simulated-sent");
      }
      if (ltpCandidate) {
        try {
          await recordLtpSequenceSend(player.club_id, context.messageId, "simulated");
        } catch (error) {
          logger.error({ messageId: context.messageId, err: error }, "Simulated LTP delivery persisted but its sequence bookkeeping failed");
        }
      }
      return { sid: "SIMULATED", simulated: true, isTest };
    }

    let msg;
    if (messagingServiceSid) {
      await assertFinalTransportAllowed(player.club_id, audit);
      msg = await client!.messages.create({
        body,
        to: effectiveTo,
        messagingServiceSid,
        shortenUrls: true,
        ...(statusCallbackUrl ? { statusCallback: statusCallbackUrl } : {}),
      });
    } else {
      await assertFinalTransportAllowed(player.club_id, audit);
      msg = await client!.messages.create({
        body,
        to: effectiveTo,
        from: from!,
        ...(statusCallbackUrl ? { statusCallback: statusCallbackUrl } : {}),
      });
    }
    const sentAt = currentTime().toISOString();
    const ledgerRow = {
      club_id: player.club_id,
      message_id: context.messageId,
      is_test: isTest,
      intended_player_id: playerId,
      player_id: isTest ? null : playerId,
      experiment_id: context.experimentId ?? null,
      source: context.source ?? "retention",
      channel: "sms",
      purpose: context.purpose ?? "promotion",
      sent_at: sentAt,
    };
    const { error: ledgerError } = await supabase.from("contact_ledger").insert(ledgerRow);
    if (ledgerError) {
      logger.error({ messageId: context.messageId, err: ledgerError.message }, "SMS delivered but contact ledger write failed; dispatch claim retained for reconciliation");
      throw new Error(`SMS may have been delivered but contact ledger write failed: ${ledgerError.message}`);
    }

    let messageUpdateQuery = supabase
      .from("messages")
      .update({
        status: "sent",
        twilio_message_sid: msg.sid,
        simulated: false,
        sent_at: sentAt,
        ...(ltpCandidate
          ? {
              ...(isTest
                ? { retention_delivery_kind: "test" }
                : msg.status === "delivered" ? { retention_delivery_kind: "real" } : {}),
              ...(msg.status === "delivered" ? { delivery_status: "delivered", delivered_at: sentAt } : {}),
            }
          : {}),
      })
      .eq("id", context.messageId)
      .eq("status", "pending");
    messageUpdateQuery = ltpCandidate
      ? messageUpdateQuery.eq("dispatch_claimed_at", claimedAt).is("dispatch_token", null)
      : messageUpdateQuery.eq("dispatch_token", claimToken);
    const { data: updated, error: messageUpdateError } = await messageUpdateQuery
      .select(ltpCandidate ? "id,delivery_status,delivered_at" : "id")
      .maybeSingle();
    if (messageUpdateError || !updated) {
      throw new Error(`SMS may have been delivered but message bookkeeping failed: ${messageUpdateError?.message ?? "claim no longer owns the pending message"}`);
    }

    const { error: candidateError } = await supabase
      .from("retention_candidates")
      .update({ status: "sent", updated_at: sentAt })
      .eq("message_id", context.messageId)
      .eq("status", "approved");
    if (candidateError && !/does not exist|schema cache/i.test(candidateError.message)) {
      logger.error({ messageId: context.messageId, err: candidateError.message }, "Could not record linked retention candidate as sent");
    }

    if (ltpCandidate && isTest) {
      try {
        await recordLtpSequenceSend(player.club_id, context.messageId, "test");
      } catch (error) {
        logger.error({ messageId: context.messageId, err: error }, "Redirected LTP test delivery persisted but its sequence bookkeeping failed");
      }
    } else if (ltpCandidate && msg.status === "delivered") {
      try {
        await confirmLtpRecipientDelivery(context.messageId);
      } catch (error) {
        logger.error({ messageId: context.messageId, err: error }, "Delivered LTP message persisted but its real-delivery bookkeeping failed");
        throw new Error(`LTP SMS was delivered but its sequence could not be updated: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (
      ltpCandidate
      && !isTest
      && (updated as any)?.delivery_status === "delivered"
      && (updated as any)?.delivered_at
    ) {
      try {
        await confirmLtpRecipientDelivery(context.messageId);
      } catch (error) {
        logger.error({ messageId: context.messageId, err: error }, "Earlier Twilio delivery receipt could not be applied to the LTP sequence");
      }
    }

    if (!isTest) {
      const { error: cooldownError } = await supabase
        .from("players")
        .update({ last_outbound_at: sentAt })
        .eq("id", playerId);
      if (cooldownError) {
        logger.error({ messageId: context.messageId, playerId, err: cooldownError.message }, "SMS sent but player cooldown bookkeeping failed");
      }
    }

    return { sid: msg.sid, simulated: false, isTest };
  } catch (error: any) {
    if (error instanceof SmsPolicyBlockedError) {
      const releaseValues = error.sequenceAlreadyExited
        ? {
            status: "skipped",
            error_message: "LTP player booked a session before message transport",
            dispatch_claimed_at: null,
            dispatch_token: null,
          }
        : { dispatch_claimed_at: null, dispatch_token: null };
      let releaseQuery = supabase
        .from("messages")
        .update(releaseValues)
        .eq("id", context.messageId)
        .eq("status", "pending");
      releaseQuery = ltpCandidate
        ? releaseQuery.eq("dispatch_claimed_at", claimedAt).is("dispatch_token", null)
        : releaseQuery.eq("dispatch_token", claimToken);
      const { error: releaseError } = await releaseQuery;
      if (releaseError) {
        logger.error({ messageId: context.messageId, err: releaseError.message }, "Could not release message claim after pre-transport policy block");
      }
      throw error;
    }
    throw new SmsDispatchClaimedError(
      error?.message ?? "SMS dispatch failed after the message was claimed",
      context.messageId,
      claimToken,
      error,
      ltpCandidate ? claimedAt : undefined,
      playerId,
      player.club_id,
    );
  }
}

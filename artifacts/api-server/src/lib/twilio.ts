import twilio from "twilio";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import { isRetentionOnlyMode, isTextEligible, requiresMarketingConsent } from "./retentionPolicy";
import { isInsideSendWindow } from "./playerTiming";
import { supabase } from "./supabaseClient";
import { validateRetentionCoupon } from "./retentionCoupons";
import { verifyRetentionCandidateDispatch } from "./retentionDispatch";

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

const currentTime = () => testClock ? testClock() : new Date();

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
}

export class SmsPolicyBlockedError extends Error {
  readonly code = "SMS_POLICY_BLOCKED";

  constructor(message: string) {
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

  constructor(message: string, readonly messageId: string, readonly claimToken: string, cause?: unknown) {
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

export function getSmsDispatchClaim(error: unknown): { messageId: string; claimToken: string } | null {
  return error instanceof SmsDispatchClaimedError
    ? { messageId: error.messageId, claimToken: error.claimToken }
    : null;
}

export async function recordSmsDispatchFailure(error: unknown): Promise<boolean> {
  const claim = getSmsDispatchClaim(error);
  if (!claim) return false;

  const { data, error: updateError } = await supabase
    .from("messages")
    .update({
      status: "failed",
      error_code: (error as any)?.cause?.code?.toString?.() ?? (error as any)?.code?.toString?.(),
      error_message: error instanceof Error ? error.message : "Unknown dispatch error",
    })
    .eq("id", claim.messageId)
    .eq("status", "pending")
    .eq("dispatch_token", claim.claimToken)
    .select("id")
    .maybeSingle();

  if (updateError) {
    logger.error({ messageId: claim.messageId, err: updateError.message }, "Could not record failed SMS dispatch");
    return false;
  }
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

  const approvedBody = composeApprovedMessageBody(message.body ?? "", message.signup_url);
  if (approvedBody !== message.approved_body || body !== approvedBody) {
    throw new Error("Message body does not match its approved body");
  }

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
  const retentionCandidate = await verifyRetentionCandidateDispatch(
    context.messageId,
    playerId,
    player.club_id,
    message.approved_at,
  );
  const promoCode = (retentionCandidate?.context as any)?.promo?.code;

  if (!isInsideSendWindow(currentTime())) {
    throw new SmsPolicyBlockedError("SMS dispatch is outside the TCPA send window");
  }

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

  const client = smsLive
    ? (testClientFactory ? testClientFactory() : getTwilioClient())
    : null;

  const claimToken = randomUUID();
  const claimedAt = currentTime().toISOString();
  const { data: claimed, error: claimError } = await supabase
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
  if (claimError || !claimed) {
    throw new SmsDispatchClaimError(`Message dispatch claim failed: ${claimError?.message ?? "message is no longer dispatchable"}`);
  }

  try {
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
    if (typeof promoCode === "string" && promoCode.trim()) {
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
    if (!isInsideSendWindow(currentTime())) {
      throw new SmsPolicyBlockedError("SMS dispatch crossed outside the TCPA send window");
    }
    const { data: lastChanceClub, error: lastChanceError } = await supabase
      .from("clubs")
      .select("sms_kill_switch")
      .eq("id", player.club_id)
      .maybeSingle();
    if (lastChanceError || !lastChanceClub || lastChanceClub.sms_kill_switch !== false) {
      throw new SmsPolicyBlockedError(`SMS kill switch blocked dispatch: ${lastChanceError?.message ?? "engaged or unavailable"}`);
    }

    if (!smsLive) {
      logger.info({ messageId: context.messageId, isTest }, "[SMS DRY-RUN] approved dispatch simulated");
      const sentAt = currentTime().toISOString();
      const { data: updated, error: updateError } = await supabase
        .from("messages")
        .update({ status: "sent", twilio_message_sid: "SIMULATED", simulated: true, sent_at: sentAt })
        .eq("id", context.messageId)
        .eq("status", "pending")
        .eq("dispatch_token", claimToken)
        .select("id")
        .maybeSingle();
      if (updateError || !updated) throw new Error(`Could not record simulated dispatch: ${updateError?.message ?? "claim no longer owns the pending message"}`);
      const { error: candidateError } = await supabase
        .from("retention_candidates")
        .update({ status: "sent", updated_at: sentAt })
        .eq("message_id", context.messageId)
        .eq("status", "approved");
      if (candidateError && !/does not exist|schema cache/i.test(candidateError.message)) {
        logger.error({ messageId: context.messageId, err: candidateError.message }, "Could not record linked retention candidate as simulated-sent");
      }
      return { sid: "SIMULATED", simulated: true, isTest };
    }

    let msg;
    if (messagingServiceSid) {
      msg = await client!.messages.create({
        body,
        to: effectiveTo,
        messagingServiceSid,
        shortenUrls: true,
        ...(statusCallbackUrl ? { statusCallback: statusCallbackUrl } : {}),
      });
    } else {
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

    const { data: updated, error: messageUpdateError } = await supabase
      .from("messages")
      .update({ status: "sent", twilio_message_sid: msg.sid, simulated: false, sent_at: sentAt })
      .eq("id", context.messageId)
      .eq("status", "pending")
      .eq("dispatch_token", claimToken)
      .select("id")
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
      const { error: releaseError } = await supabase
        .from("messages")
        .update({ dispatch_claimed_at: null, dispatch_token: null })
        .eq("id", context.messageId)
        .eq("status", "pending")
        .eq("dispatch_token", claimToken);
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
    );
  }
}

import { Router, type IRouter } from "express";
import { recordOperatorTestReceipt } from "../lib/operatorTestMessage";
import { alertOperator } from "../lib/operatorMonitoring";
import { z } from "zod";
import { supabase } from "../lib/supabaseClient";
import { captureInboundSms } from "../lib/inboundSms";
import { alertOptOutEvent, recordCarrierOptOutEvent } from "../lib/smsOptouts";
import {
  composeApprovedMessageBody,
  isSmsDispatchClaimError,
  isSmsPolicyBlockedError,
  isTwilio21610,
  recordSmsDispatchFailure,
  sendViaTwilio,
} from "../lib/twilio";
import { computeLevelConfidence } from "../lib/levelConfidence";
import { parseFeedbackReply } from "../lib/postSessionFeedback";
import { findActiveExpectation, resolveExpectation } from "../lib/replyExpectations";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { isRetentionOnlyMode, isTextEligible, parkInRetentionOnlyMode, requiresMarketingConsent } from "../lib/retentionPolicy";
import { RetentionDispatchAuthorizationError, verifyRetentionCandidateDispatch } from "../lib/retentionDispatch";
import {
  applyTwilio21610OptOut,
  confirmLtpRecipientDelivery,
  SmsOptOutPersistenceError,
} from "../lib/ltpSequenceLifecycle";
import { smsLiveEnabled } from "../lib/backgroundPolicy";

const router: IRouter = Router();

// ─── Constants ───────────────────────────────────────────────────────────────

/** 24-hour cooldown between outbound messages to the same player */
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find any unresolved {{variable}} tokens in a message body.
 * Returns an array of variable names. Empty array = all clear.
 */
function findUnresolvedVars(body: string): string[] {
  const matches = body.match(/\{\{[^}]+\}\}/g) ?? [];
  return matches.map((m) => m.slice(2, -2).trim());
}

/**
 * Interpolate per-player template variables.
 * clubName comes from the clubs table — never hardcoded.
 */
function interpolate(body: string, player: any, clubName: string): string {
  const firstName = (player.name as string).split(" ")[0];
  const skillLevel = player.skill_level ?? "your level";
  const lastVisit = player.last_visit_date
    ? new Date(player.last_visit_date + "T12:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : "a while";
  return body
    .replace(/\{\{first_name\}\}/gi, firstName)
    .replace(/\{\{skill_level\}\}/gi, skillLevel)
    .replace(/\{\{last_visit\}\}/gi, lastVisit)
    .replace(/\{\{club_name\}\}/gi, clubName);
}

// ─── POST /api/messages/send ─────────────────────────────────────────────────

const SendSchema = z.object({
  message_id: z.string().uuid("message_id must be a valid UUID"),
});

router.post("/messages/send", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;

  const parsed = SendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  const { message_id } = parsed.data;

  // Load message + conversation + player in one go
  const { data: message, error: msgErr } = await supabase
    .from("messages")
    .select("id, body, signup_url, status, conversation_id, player_id, approved_at, approved_by, approved_body, dispatch_claimed_at, dispatch_token")
    .eq("id", message_id)
    .single();

  if (msgErr || !message) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  // Guard: already processed
  if (message.status !== "pending") {
    res.status(409).json({ error: `Message is already ${message.status}` });
    return;
  }
  if (!message.approved_at) {
    res.status(403).json({ error: "Message requires explicit per-message approval before sending" });
    return;
  }
  if (message.dispatch_claimed_at || message.dispatch_token) {
    res.status(409).json({ error: "Message dispatch is already claimed and requires reconciliation" });
    return;
  }

  const { data: conversation, error: convErr } = message.conversation_id
    ? await supabase.from("conversations").select("player_id, club_id").eq("id", message.conversation_id).maybeSingle()
    : { data: null, error: null };

  if (convErr || (!conversation && !message.player_id)) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  // Cross-tenant guard: conversation must belong to this club
  if (conversation?.club_id && conversation.club_id !== clubId) {
    res.status(403).json({ error: "Message does not belong to this club" });
    return;
  }

  const { data: player, error: playerErr } = await supabase
    .from("players")
    .select("id, name, phone, opted_out, sms_opt_in, consent_source, sms_consented_at, last_outbound_at, club_id")
    .eq("id", message.player_id ?? conversation?.player_id)
    .single();

  if (playerErr || !player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  // Cross-tenant guard: player must belong to this club
  if (player.club_id !== clubId) {
    res.status(403).json({ error: "Player does not belong to this club" });
    return;
  }

  if (isRetentionOnlyMode()) {
    try {
      await verifyRetentionCandidateDispatch(message_id, player.id, player.club_id, message.approved_at);
    } catch (err) {
      if (err instanceof RetentionDispatchAuthorizationError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      throw err;
    }
  }

  // Guard: opted out
  if (player.opted_out === true || (!isRetentionOnlyMode() && requiresMarketingConsent() && !isTextEligible(player))) {
    await supabase
      .from("messages")
      .update({ status: "skipped", error_message: "Player is not eligible for SMS" })
      .eq("id", message_id)
      .eq("status", "pending")
      .is("dispatch_claimed_at", null)
      .is("dispatch_token", null);
    res.status(200).json({ skipped: true, reason: "Player is not eligible for SMS" });
    return;
  }

  // Guard: no phone
  if (!player.phone?.trim()) {
    await supabase
      .from("messages")
      .update({ status: "skipped", error_message: "No phone number on record" })
      .eq("id", message_id)
      .eq("status", "pending")
      .is("dispatch_claimed_at", null)
      .is("dispatch_token", null);
    res.status(200).json({ skipped: true, reason: "No phone number on record" });
    return;
  }

  // Guard: cooldown
  if (!isRetentionOnlyMode() && smsLiveEnabled() && !process.env.SMS_TEST_OVERRIDE_TO?.trim() && player.last_outbound_at) {
    const elapsed = Date.now() - new Date(player.last_outbound_at).getTime();
    if (elapsed < COOLDOWN_MS) {
      const remainingMins = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
      await supabase
        .from("messages")
        .update({
          status: "skipped",
          error_message: `Cooldown active — ${remainingMins}min remaining`,
        })
        .eq("id", message_id)
        .eq("status", "pending")
        .is("dispatch_claimed_at", null)
        .is("dispatch_token", null);
      res.status(200).json({
        skipped: true,
        reason: "cooldown",
        remaining_minutes: remainingMins,
      });
      return;
    }
  }

  // Guard: unresolved variables
  const unresolved = findUnresolvedVars(message.body);
  if (unresolved.length > 0) {
    res.status(400).json({
      error: "Message contains unresolved template variables",
      unresolved_vars: unresolved,
    });
    return;
  }

  // Build final SMS body
  const smsBody = composeApprovedMessageBody(message.body, message.signup_url);

  try {
    const { sid, simulated, isTest } = await sendViaTwilio(player.phone, smsBody, {
      messageId: message_id,
      source: "retention",
      purpose: "promotion",
    });

    req.log.info({ message_id, simulated, isTest }, "SMS dispatch completed");
    res.json({ success: true, twilio_sid: sid, simulated, isTest, to: player.phone });
  } catch (err: unknown) {
    req.log.error({ err }, "Twilio send failed");
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    await recordSmsDispatchFailure(err);

    const statusCode = err instanceof RetentionDispatchAuthorizationError
      ? err.statusCode
      : isSmsPolicyBlockedError(err) || isSmsDispatchClaimError(err) ? 409 : 502;
    res.status(statusCode)
      .json({ error: "Failed to send SMS", detail: errMsg });
  }
});

// ─── POST /api/messages/skip ─────────────────────────────────────────────────

router.post("/messages/skip", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { message_id } = req.body as { message_id?: string };

  if (!message_id) {
    res.status(400).json({ error: "message_id is required" });
    return;
  }

  // Cross-tenant guard: verify the message's player belongs to this club
  const { data: msg } = await supabase
    .from("messages")
    .select("player_id, dispatch_claimed_at, dispatch_token, players!inner(club_id)")
    .eq("id", message_id)
    .maybeSingle();

  if (!msg) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  if (msg.dispatch_claimed_at || msg.dispatch_token) {
    res.status(409).json({ error: "Message dispatch is already claimed and requires reconciliation" });
    return;
  }
  const playerClubId = (msg.players as any)?.club_id;
  if (playerClubId && playerClubId !== clubId) {
    res.status(403).json({ error: "Message does not belong to this club" });
    return;
  }

  const { error } = await supabase
    .from("messages")
    .update({ status: "skipped", error_message: "Skipped by operator" })
    .eq("id", message_id)
    .eq("status", "pending")
    .is("dispatch_claimed_at", null)
    .is("dispatch_token", null);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ skipped: true });
});

// ─── POST /api/messages/mark-read ────────────────────────────────────────────

/** Bounded batches so one request can't run unbounded against a large inbox. */
const MARK_READ_BATCH = 500;
const MARK_READ_MAX_BATCHES = 10;

router.post("/messages/mark-read", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  let marked = 0;

  // PostgREST cannot safely apply a joined players.club_id predicate to an
  // UPDATE. Resolve only this club's unread message IDs first, then update
  // bounded ID batches while rechecking the unread conditions.
  for (let batch = 0; batch < MARK_READ_MAX_BATCHES; batch++) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, players!player_id!inner(club_id)")
      .eq("direction", "inbound")
      .eq("players.club_id", clubId)
      .is("read_at", null)
      .limit(MARK_READ_BATCH);
    if (error) {
      res.status(500).json({ error: error.message, marked });
      return;
    }
    if (!data?.length) break;
    const ids = data.map((row: { id: string }) => row.id);
    const { data: updated, error: updateError } = await supabase
      .from("messages")
      .update({ read_at: new Date().toISOString() })
      .in("id", ids)
      .eq("direction", "inbound")
      .is("read_at", null)
      .select("id");
    if (updateError) {
      res.status(500).json({ error: updateError.message, marked });
      return;
    }
    marked += updated?.length ?? 0;
    if (data.length < MARK_READ_BATCH) break;
  }

  const { count, error: countError } = await supabase
    .from("messages")
    .select("id, players!player_id!inner(club_id)", { count: "exact", head: true })
    .eq("direction", "inbound")
    .eq("players.club_id", clubId)
    .is("read_at", null);
  if (countError) {
    res.status(500).json({ error: countError.message, marked });
    return;
  }

  res.json({ marked, unread: count ?? 0 });
});

// ─── POST /api/messages/bulk ─────────────────────────────────────────────────

router.post("/messages/bulk", parkInRetentionOnlyMode("Bulk message sending is parked by RETENTION_ONLY_MODE"), requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;

  const { player_ids, message_body, template_id, approved_by } = req.body as {
    player_ids?: string[];
    message_body?: string;
    template_id?: string;
    approved_by?: string;
  };

  if (typeof approved_by !== "string" || !approved_by.trim()) {
    res.status(400).json({ error: "approved_by is required for bulk message approval" });
    return;
  }

  if (!Array.isArray(player_ids) || player_ids.length === 0) {
    res.status(400).json({ error: "player_ids must be a non-empty array" });
    return;
  }
  if (!message_body || typeof message_body !== "string" || !message_body.trim()) {
    res.status(400).json({ error: "message_body is required" });
    return;
  }

  // Server-side guard: reject any unresolved variables regardless of frontend state
  const unresolved = findUnresolvedVars(message_body);
  if (unresolved.length > 0) {
    res.status(400).json({
      error: "Message body contains unresolved template variables. Resolve all variables before sending.",
      unresolved_vars: unresolved,
    });
    return;
  }

  // Fetch club name for {{club_name}} interpolation
  const { data: clubRow } = await supabase
    .from("clubs")
    .select("name")
    .eq("id", clubId)
    .maybeSingle();
  const clubName = clubRow?.name ?? "your club";

  // Fetch eligible players scoped to this club
  const { data: players, error: fetchErr } = await supabase
    .from("players")
    .select("id, name, skill_level, last_visit_date, phone, club_id, opted_out, sms_opt_in, consent_source, sms_consented_at, last_outbound_at")
    .in("id", player_ids)
    .eq("club_id", clubId);

  if (fetchErr) {
    res.status(500).json({ error: "Failed to fetch players", detail: fetchErr.message });
    return;
  }

  const eligible = (players ?? []).filter((p: any) =>
    !isRetentionOnlyMode() && requiresMarketingConsent()
      ? isTextEligible(p)
      : !!p.phone?.trim() && p.opted_out !== true
  );

  if (eligible.length === 0) {
    res.json({ sent: 0, skipped_cooldown: 0, failed: 0, errors: [] });
    return;
  }

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const now = Date.now();

  let sent = 0;
  let skipped_cooldown = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const player of eligible) {
    // Cooldown check
    if (!isRetentionOnlyMode() && smsLiveEnabled() && !process.env.SMS_TEST_OVERRIDE_TO?.trim() && player.last_outbound_at) {
      const elapsed = now - new Date(player.last_outbound_at).getTime();
      if (elapsed < COOLDOWN_MS) {
        skipped_cooldown++;
        continue;
      }
    }

    const interpolated = interpolate(message_body, player, clubName);

    // Final unresolved check after per-player interpolation
    const stillUnresolved = findUnresolvedVars(interpolated);
    if (stillUnresolved.length > 0) {
      req.log.warn({ player_id: player.id, stillUnresolved }, "Bulk: unresolved vars after interpolation");
      failed++;
      errors.push(player.id);
      continue;
    }

    // Create conversation record
    const { data: convData, error: convErr } = await supabase
      .from("conversations")
      .insert({ player_id: player.id, club_id: clubId, triggered_by: "bulk" })
      .select("id")
      .single();

    if (convErr || !convData) {
      req.log.error({ err: convErr, player_id: player.id }, "Bulk: failed to create conversation");
      failed++;
      errors.push(player.id);
      continue;
    }

    const conversation_id: string = convData.id;
    const sentAt = new Date().toISOString();

    // INSERT message row BEFORE calling Twilio — row must exist from the moment
    // Twilio is invoked. If this INSERT fails, skip Twilio entirely.
    const { data: msgRow, error: msgInsertErr } = await supabase
      .from("messages")
      .insert({
        conversation_id,
        player_id: player.id,
        body: interpolated,
        approved_at: new Date().toISOString(),
        approved_by: approved_by.trim(),
        approved_body: interpolated,
        direction: "outbound",
        sent_by: "operator",
        status: "pending",
      })
      .select("id")
      .single();

    if (msgInsertErr || !msgRow) {
      req.log.error({ err: msgInsertErr, player_id: player.id }, "Bulk: failed to insert message row");
      failed++;
      errors.push(player.id);
      continue;
    }

    // sendViaTwilio handles the SMS_LIVE gate; dry-run returns { sid:"SIMULATED", simulated:true }
    try {
      const { sid: twilio_message_sid, simulated } = await sendViaTwilio(player.phone, interpolated, {
        messageId: msgRow.id,
        source: "bulk",
        purpose: "promotion",
      });
    } catch (err) {
      req.log.error({ err, player_id: player.id }, "Bulk: Twilio send failed");
      await recordSmsDispatchFailure(err);
      failed++;
      errors.push(player.id);
      continue;
    }

    sent++;
    req.log.info({ player_id: player.id, template_id }, "Bulk SMS sent");

    await delay(100);
  }

  res.json({ sent, skipped_cooldown, failed, errors });
});

// ─── POST /api/messages/webhook/status ───────────────────────────────────────
// Twilio calls this for delivery status AND link click events.
// Body is application/x-www-form-urlencoded (already parsed by app.ts).
// NO requireClub — Twilio posts without club context.

router.post("/messages/webhook/status", async (req, res) => {
  const { MessageSid, MessageStatus, ErrorCode, ErrorMessage, event } =
    req.body as Record<string, string>;

  const messageSid = MessageSid;
  if (!messageSid) {
    res.status(400).send("Missing MessageSid");
    return;
  }

  req.log.info({ MessageSid, MessageStatus, event }, "Twilio status webhook received");
  const callbackAt = new Date().toISOString();

  // Link click event
  const isClick =
    MessageStatus === "clicked" ||
    event === "link_click" ||
    event === "clicked";

  if (isClick) {
    await supabase
      .from("messages")
      .update({ link_clicked: true, link_clicked_at: new Date().toISOString() })
      .eq("twilio_message_sid", messageSid);
    res.status(204).send();
    return;
  }

  // Delivery status events — now written back to DB
  const update: Record<string, any> = {
    delivery_status: MessageStatus,
  };

  const deliveredAt = MessageStatus === "delivered" ? new Date().toISOString() : null;
  if (deliveredAt) {
    update.delivered_at = deliveredAt;
  } else if (MessageStatus === "failed" || MessageStatus === "undelivered") {
    update.status = MessageStatus;
    if (ErrorCode) update.error_code = ErrorCode;
    if (ErrorMessage) update.error_message = ErrorMessage;
  }

  let affected: any;
  let statusError: { message: string } | null = null;
  // These query parameters are covered by Twilio's signature validation in
  // app.ts. They correlate receipts only; they never authorize a dispatch.
  const memberId = req.query.member_message_id;
  const claimedAt = req.query.dispatch_claimed_at;
  const claimToken = req.query.dispatch_token;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const memberCorrelation = memberId !== undefined;
  if (memberCorrelation && (
    typeof memberId !== "string" || !uuid.test(memberId)
    || typeof claimedAt !== "string" || !Number.isFinite(Date.parse(claimedAt))
    || (claimToken !== undefined && (typeof claimToken !== "string" || !uuid.test(claimToken)))
  )) {
    res.status(400).send("Invalid member dispatch correlation");
    return;
  }
  const bindMemberClaim = (query: any) => {
    if (!memberCorrelation) return query;
    query = query.eq("id", memberId).eq("dispatch_claimed_at", claimedAt)
      .not("approved_at", "is", null).not("approved_by", "is", null).not("approved_body", "is", null)
      .or("player_id.not.is.null,conversation_id.not.is.null");
    return claimToken === undefined ? query.is("dispatch_token", null) : query.eq("dispatch_token", claimToken);
  };
  // Operator tests live in operator_test_messages (migration 030), never in
  // messages: no player, milestone or opt-out handling applies to them.
  const operatorId = req.query.operator_test_id;
  if (operatorId !== undefined) {
    if (memberCorrelation || typeof operatorId !== "string" || !uuid.test(operatorId)) {
      res.status(400).send("Invalid operator test correlation");
      return;
    }
    const receipt = await recordOperatorTestReceipt(operatorId, messageSid, MessageStatus, ErrorCode, ErrorMessage);
    if (receipt.error) {
      req.log.error({ err: receipt.error.message, MessageSid }, "Could not persist operator test delivery status");
      res.status(503).send("Could not persist delivery status; retry required");
      return;
    }
    if (!receipt.matched) req.log.warn({ MessageSid }, "Signed operator test receipt matched no recorded test");
    if (MessageStatus === "failed" || MessageStatus === "undelivered") {
      void alertOperator(`delivery-failed:${MessageSid}`, `Twilio reported an SMS as ${MessageStatus}. Check message logs.`);
    }
    res.status(204).send();
    return;
  }
  try {
    const result = await bindMemberClaim(supabase
      .from("messages")
      .update(update)
      .eq("twilio_message_sid", messageSid))
      .select("id,player_id,conversation_id,retention_delivery_kind");
    affected = result.data;
    statusError = result.error;
    if (!statusError && !affected?.length && memberCorrelation) {
      const early = await bindMemberClaim(supabase.from("messages")
        .update({ ...update, twilio_message_sid: messageSid })
        .is("twilio_message_sid", null))
        .select("id,player_id,conversation_id,retention_delivery_kind");
      affected = early.data;
      statusError = early.error;
      if (!statusError && !affected?.length) {
        statusError = { message: "Signed member receipt did not match its approved dispatch claim" };
      }
    }
  } catch (error) {
    statusError = { message: error instanceof Error ? error.message : String(error) };
  }
  if (statusError) {
    req.log.error({ err: statusError.message, MessageSid }, "Could not persist Twilio delivery status");
  }

  // Real 21610 failures receive one context-rich opt-out alert below instead
  // of an additional generic delivery failure alert.
  if ((MessageStatus === "failed" || MessageStatus === "undelivered") && !isTwilio21610(ErrorCode)) {
    void alertOperator(`delivery-failed:${MessageSid}`, `Twilio reported an SMS as ${MessageStatus}. Check message logs.`);
  }
  if (isTwilio21610(ErrorCode)) {
    let messages = Array.isArray(affected) ? affected : affected ? [affected] : [];
    if (!messages.length) {
      const { data: linked, error: lookupError } = await bindMemberClaim(supabase
        .from("messages")
        .select("id,player_id,conversation_id")
        .eq("twilio_message_sid", messageSid))
        .maybeSingle();
      if (lookupError) {
        req.log.error({ err: lookupError.message, MessageSid }, "Could not resolve message for Twilio opt-out");
        res.status(500).send("Could not resolve the player for Twilio opt-out");
        return;
      }
      if (linked) messages = [linked];
    }
    const playerIds = new Set<string>();
    const optOutMessages: Array<{ messageId: string; playerId: string }> = [];
    for (const message of messages) {
      if (message?.player_id) {
        playerIds.add(String(message.player_id));
        optOutMessages.push({ messageId: String(message.id), playerId: String(message.player_id) });
        continue;
      }
      if (message?.conversation_id) {
        const { data: conversation, error: conversationError } = await supabase
          .from("conversations")
          .select("player_id")
          .eq("id", message.conversation_id)
          .maybeSingle();
        if (conversationError) {
          req.log.error({ err: conversationError.message, MessageSid }, "Could not resolve conversation player for Twilio opt-out");
          res.status(500).send("Could not resolve the player for Twilio opt-out");
          return;
        }
        if (conversation?.player_id) {
          playerIds.add(String(conversation.player_id));
          optOutMessages.push({ messageId: String(message.id), playerId: String(conversation.player_id) });
        }
      }
    }
    if (!playerIds.size) {
      req.log.error({ MessageSid }, "Twilio opt-out status did not resolve a linked player");
      res.status(500).send("Could not resolve the player for Twilio opt-out");
      return;
    }
    try {
      for (const playerId of playerIds) {
        await applyTwilio21610OptOut(playerId, "twilio_error_21610");
      }
      for (const message of optOutMessages) {
        const eventId = await recordCarrierOptOutEvent(message.playerId, message.messageId, callbackAt);
        await alertOptOutEvent(eventId);
      }
    } catch (error) {
      req.log.error({ err: error, MessageSid }, "Could not persist the Twilio 21610 opt-out");
      res.status(500).send(
        error instanceof SmsOptOutPersistenceError && error.playerOptOutPersisted
          ? "Player opt-out was saved, but LTP sequence exit failed; retry required"
          : "Could not persist the player opt-out; retry required",
      );
      return;
    }
    if (statusError) {
      res.status(500).send("Player opt-out was saved, but Twilio delivery status persistence failed; retry required");
      return;
    }
  }

  if (statusError) {
    res.status(503).send("Could not persist delivery status; retry required");
    return;
  }
  if (deliveredAt && affected) {
    for (const message of (Array.isArray(affected) ? affected : [affected])) {
      if (!message?.id) continue;
      try {
        await confirmLtpRecipientDelivery(message.id);
      } catch (error) {
        req.log.error({ err: error, message_id: message.id }, "Confirmed LTP delivery could not be applied to its sequence");
      }
    }
  }

  res.status(204).send();
});

// ─── POST /api/messages/webhook/inbound ──────────────────────────────────────
// Twilio posts here when a member replies or sends STOP.
// Tenant comes from the signature-covered clubSlug URL parameter, or the
// configured default-club endpoint. Never infer it from an arbitrary player.

router.get("/messages/inbound/unmatched", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { data, error } = await supabase.from("sms_inbound_receipts")
    .select("id,body,from_phone,kind,match_reason,received_at,twilio_message_sid")
    .eq("club_id", clubId).is("player_id", null).order("received_at", { ascending: false }).limit(200);
  if (error) return void res.status(503).json({ error: "Unmatched inbox unavailable; install migration 021" });
  res.json({ messages: data ?? [] });
});

router.post("/messages/webhook/inbound", async (req, res) => {
  const { From, Body } = req.body as { From?: string; Body?: string };

  if (!From || typeof Body !== "string") {
    res.status(400).send("Missing From or Body");
    return;
  }

  let receipt: Awaited<ReturnType<typeof captureInboundSms>>;
  try {
    receipt = await captureInboundSms(req.body,
      typeof req.query.clubSlug === "string" ? req.query.clubSlug : undefined);
  } catch (error) {
    req.log.error({ twilio_sid: req.body.MessageSid, reason: error instanceof Error ? error.message : "Persistence failed" }, "Inbound SMS not acknowledged");
    return void res.status(error instanceof Error && error.message === "Invalid inbound SMS payload" ? 400 : 503)
      .json({ error: "Could not safely capture inbound SMS" });
  }
  req.log.info({ twilio_sid: req.body.MessageSid, receipt_id: receipt.id, club_id: receipt.club_id,
    player_id: receipt.player_id, message_id: receipt.message_id, match_reason: receipt.match_reason,
    kind: receipt.kind, duplicate: receipt.duplicate }, "Inbound SMS stored");
  if (receipt.optout_type_mismatch && receipt.optout_event_created) {
    req.log.warn({ receipt_id: receipt.id, twilio_optout_type: receipt.twilio_optout_type },
      "Twilio OptOutType indicated STOP but the body classifier did not; provider classification enforced");
  }
  if (receipt.optout_event_id) {
    try {
      await alertOptOutEvent(receipt.optout_event_id);
    } catch (error) {
      req.log.error({ event_id: receipt.optout_event_id, reason: error instanceof Error ? error.message : "Alert failed" },
        "Opt-out saved but operator alert incomplete");
      return void res.status(503).json({ error: "Opt-out was saved, but operator alert requires retry or reconciliation" });
    }
  }
  if (receipt.processing_error || !receipt.processed_at) {
    return void res.status(503).json({ error: receipt.kind === "stop"
      ? "STOP was saved, but sequence processing failed; retry required"
      : "Reply was saved, but sequence processing failed; retry required" });
  }
  if (receipt.duplicate || !receipt.player_id || receipt.kind !== "reply") {
    return void res.type("text/xml").status(200).send("<Response></Response>");
  }
  const { data: player, error: playerError } = await supabase.from("players")
    .select("id,name,phone,sms_opt_in,club_id").eq("id", receipt.player_id).eq("club_id", receipt.club_id).maybeSingle();
  if (playerError || !player) return void res.status(503).json({ error: "Stored reply player unavailable" });

  // ── Session feedback reply ──
  // Check whether the most recent outbound to this player was a session_feedback request
  // that hasn't yet received a response.
  const expectation = isRetentionOnlyMode()
    ? null
    : await findActiveExpectation(player.id, "session_feedback");

  if (expectation) {
    const meta = expectation.metadata as { event_id: string; level: string };

    // Check if they already submitted feedback for this event
    const { data: existingFb } = await supabase
      .from("session_feedback")
      .select("id")
      .eq("player_id", player.id)
      .eq("event_id", meta.event_id)
      .maybeSingle();

    if (!existingFb) {
      // Thread reply into the feedback conversation
      const conversationId: string | undefined =
        expectation.conversation_id ?? undefined;

      if (conversationId) {
        const threaded = await supabase.from("messages").update({ conversation_id: conversationId }).eq("id", receipt.message_id);
        if (threaded.error) return void res.status(503).json({ error: "Reply stored; feedback threading failed" });
      }

      const parsed = parseFeedbackReply(Body);

      if (!parsed) {
        // Unparseable — send retry prompt and leave the conversation open
        const retryMsg =
          "Thanks! Just reply with two answers like 'Y Y' or 'N Y' — " +
          "first for yourself, second for the other players.";
        try {
          const { sid, simulated } = await sendViaTwilio(From, retryMsg);
          await supabase.from("messages").insert({
            conversation_id: conversationId,
            player_id: player.id,
            body: retryMsg,
            direction: "outbound",
            sent_by: "system",
            status: "sent",
            twilio_message_sid: sid,
            simulated,
            sent_at: new Date().toISOString(),
          });
        } catch (err) {
          req.log.error({ err }, "Feedback retry prompt send failed");
        }
        res.setHeader("Content-Type", "text/xml");
        res.status(200).send("<Response></Response>");
        return;
      }

      // Valid reply — persist to session_feedback
      await supabase.from("session_feedback").upsert(
        {
          player_id: player.id,
          event_id: meta.event_id,
          level: meta.level,
          self_fit: parsed.self_fit,
          others_fit: parsed.others_fit,
          responded_at: new Date().toISOString(),
        },
        { onConflict: "player_id,event_id" }
      );

      // Recompute confidence in background — don't block the webhook response
      computeLevelConfidence(player.id).catch((err) =>
        req.log.error({ err }, "Confidence recompute failed after feedback reply")
      );

      await resolveExpectation(expectation.id, "matched");

      // Send thanks
      const thanksMsg = "Thanks! That really helps us keep sessions great for everyone 🙌";
      try {
        const { sid, simulated } = await sendViaTwilio(From, thanksMsg);
        const sentAt = new Date().toISOString();
        await supabase.from("messages").insert({
          conversation_id: conversationId,
          player_id: player.id,
          body: thanksMsg,
          direction: "outbound",
          sent_by: "system",
          status: "sent",
          twilio_message_sid: sid,
          simulated,
          sent_at: sentAt,
        });
        await supabase.from("players").update({ last_outbound_at: sentAt }).eq("id", player.id);
      } catch (err) {
        req.log.error({ err }, "Thanks message send failed");
      }

      req.log.info(
        { player_id: player.id, event_id: meta.event_id, ...parsed },
        "Session feedback recorded"
      );
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send("<Response></Response>");
      return;
    }
  }

  // ── Regular reply: thread into most recent conversation ──
  req.log.info({ player_id: player.id, message_id: receipt.message_id }, "Inbound reply captured and active sequence paused");

  // No auto-reply — operator handles manually
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send("<Response></Response>");
});

// ─── PATCH /api/messages/:id/draft ───────────────────────────────────────────
// Edit the body of a pending (unsent) message. Only works while status=pending.

router.patch("/messages/:id/draft", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { body } = req.body as { body?: unknown };
  if (!body || typeof body !== "string" || !body.trim()) {
    res.status(400).json({ error: "body is required and must be a non-empty string" });
    return;
  }

  // Cross-tenant guard: verify the message belongs to a player in this club
  const { data: existing } = await supabase
    .from("messages")
    .select("player_id, dispatch_claimed_at, dispatch_token, players!inner(club_id)")
    .eq("id", req.params.id as string)
    .maybeSingle();

  if (!existing) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  const playerClubId = (existing.players as any)?.club_id;
  if (playerClubId && playerClubId !== clubId) {
    res.status(403).json({ error: "Message does not belong to this club" });
    return;
  }

  const { data, error } = await supabase
    .from("messages")
    .update({
      body: body.trim(),
      approved_at: null,
      approved_by: null,
      approved_body: null,
      scheduled_send_at: null,
    })
    .eq("id", req.params.id as string)
    .eq("status", "pending")
    .is("dispatch_claimed_at", null)
    .is("dispatch_token", null)
    .select("id, body, status")
    .single();

  if (error || !data) {
    res
      .status(404)
      .json({ error: error?.message ?? "Message not found or not in pending status" });
    return;
  }

  res.json(data);
});

export default router;

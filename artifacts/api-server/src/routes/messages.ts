import { Router, type IRouter } from "express";
import twilio from "twilio";
import { z } from "zod";
import { supabase } from "../lib/supabaseClient";

const router: IRouter = Router();

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  }
  return twilio(accountSid, authToken);
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** TCPA-required opt-out keywords (case-insensitive exact match) */
const STOP_KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);

/** Re-subscribe keywords */
const START_KEYWORDS = new Set(["start", "yes", "unstop"]);

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

function interpolate(body: string, player: any): string {
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
    .replace(/\{\{club_name\}\}/gi, "PB Club");
}

async function sendViaTwilio(to: string, body: string): Promise<string> {
  const client = getTwilioClient();
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const statusCallbackUrl = process.env.PUBLIC_API_URL
    ? `${process.env.PUBLIC_API_URL}/api/messages/webhook/status`
    : undefined;

  let msg;
  if (messagingServiceSid) {
    msg = await client.messages.create({
      body,
      to,
      messagingServiceSid,
      shortenUrls: true,
      ...(statusCallbackUrl ? { statusCallback: statusCallbackUrl } : {}),
    });
  } else {
    msg = await client.messages.create({
      body,
      to,
      from: from!,
      ...(statusCallbackUrl ? { statusCallback: statusCallbackUrl } : {}),
    });
  }

  return msg.sid;
}

// ─── POST /api/messages/send ─────────────────────────────────────────────────

const SendSchema = z.object({
  message_id: z.string().uuid("message_id must be a valid UUID"),
});

router.post("/messages/send", async (req, res) => {
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
    .select("id, body, signup_url, status, conversation_id")
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

  const { data: conversation, error: convErr } = await supabase
    .from("conversations")
    .select("player_id")
    .eq("id", message.conversation_id)
    .single();

  if (convErr || !conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const { data: player, error: playerErr } = await supabase
    .from("players")
    .select("id, name, phone, sms_opt_in, last_outbound_at")
    .eq("id", conversation.player_id)
    .single();

  if (playerErr || !player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  // Guard: opted out
  if (!player.sms_opt_in) {
    await supabase
      .from("messages")
      .update({ status: "skipped", error_message: "Player has opted out of SMS" })
      .eq("id", message_id);
    res.status(200).json({ skipped: true, reason: "Player has opted out of SMS" });
    return;
  }

  // Guard: no phone
  if (!player.phone) {
    await supabase
      .from("messages")
      .update({ status: "skipped", error_message: "No phone number on record" })
      .eq("id", message_id);
    res.status(200).json({ skipped: true, reason: "No phone number on record" });
    return;
  }

  // Guard: cooldown
  if (player.last_outbound_at) {
    const elapsed = Date.now() - new Date(player.last_outbound_at).getTime();
    if (elapsed < COOLDOWN_MS) {
      const remainingMins = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
      await supabase
        .from("messages")
        .update({
          status: "skipped",
          error_message: `Cooldown active — ${remainingMins}min remaining`,
        })
        .eq("id", message_id);
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
  const smsBody = message.signup_url
    ? `${message.body}\n${message.signup_url}`
    : message.body;

  try {
    const sid = await sendViaTwilio(player.phone, smsBody);
    const now = new Date().toISOString();

    await Promise.all([
      supabase
        .from("messages")
        .update({ status: "sent", twilio_message_sid: sid, sent_at: now })
        .eq("id", message_id),
      supabase
        .from("players")
        .update({ last_outbound_at: now })
        .eq("id", player.id),
    ]);

    req.log.info({ message_id, twilio_sid: sid, to: player.phone }, "SMS sent");
    res.json({ success: true, twilio_sid: sid, to: player.phone });
  } catch (err: unknown) {
    req.log.error({ err }, "Twilio send failed");
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    const errCode = (err as any)?.code?.toString();

    await supabase
      .from("messages")
      .update({ status: "failed", error_code: errCode, error_message: errMsg })
      .eq("id", message_id);

    res.status(502).json({ error: "Failed to send SMS", detail: errMsg });
  }
});

// ─── POST /api/messages/skip ─────────────────────────────────────────────────

router.post("/messages/skip", async (req, res) => {
  const { message_id } = req.body as { message_id?: string };

  if (!message_id) {
    res.status(400).json({ error: "message_id is required" });
    return;
  }

  const { error } = await supabase
    .from("messages")
    .update({ status: "skipped", error_message: "Skipped by operator" })
    .eq("id", message_id)
    .eq("status", "pending");

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ skipped: true });
});

// ─── POST /api/messages/bulk ─────────────────────────────────────────────────

router.post("/messages/bulk", async (req, res) => {
  const { player_ids, message_body, template_id } = req.body as {
    player_ids?: string[];
    message_body?: string;
    template_id?: string;
  };

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

  // Fetch eligible players
  const { data: players, error: fetchErr } = await supabase
    .from("players")
    .select("id, name, skill_level, last_visit_date, phone, club_id, sms_opt_in, last_outbound_at")
    .in("id", player_ids)
    .eq("sms_opt_in", true);

  if (fetchErr) {
    res.status(500).json({ error: "Failed to fetch players", detail: fetchErr.message });
    return;
  }

  const eligible = (players ?? []).filter((p: any) => p.phone);

  if (eligible.length === 0) {
    res.json({ sent: 0, skipped_cooldown: 0, failed: 0, errors: [] });
    return;
  }

  const club_id: string | null = eligible[0]?.club_id ?? null;

  let twilioClient: ReturnType<typeof getTwilioClient> | null = null;
  try { twilioClient = getTwilioClient(); } catch { /* Twilio not configured */ }

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const now = Date.now();

  let sent = 0;
  let skipped_cooldown = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const player of eligible) {
    // Cooldown check
    if (player.last_outbound_at) {
      const elapsed = now - new Date(player.last_outbound_at).getTime();
      if (elapsed < COOLDOWN_MS) {
        skipped_cooldown++;
        continue;
      }
    }

    const interpolated = interpolate(message_body, player);

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
      .insert({ player_id: player.id, club_id, triggered_by: "bulk" })
      .select("id")
      .single();

    if (convErr || !convData) {
      req.log.error({ err: convErr, player_id: player.id }, "Bulk: failed to create conversation");
      failed++;
      errors.push(player.id);
      continue;
    }

    const conversation_id: string = convData.id;
    let twilio_message_sid: string | null = null;
    let sendFailed = false;

    if (twilioClient) {
      try {
        twilio_message_sid = await sendViaTwilio(player.phone, interpolated);
      } catch (err) {
        req.log.error({ err, player_id: player.id }, "Bulk: Twilio send failed");
        sendFailed = true;
        failed++;
        errors.push(player.id);
      }
    }

    const sentAt = new Date().toISOString();

    // Insert message record
    await supabase.from("messages").insert({
      conversation_id,
      body: interpolated,
      direction: "outbound",
      sent_by: "operator",
      status: sendFailed ? "failed" : "sent",
      ...(twilio_message_sid ? { twilio_message_sid, sent_at: sentAt } : {}),
      ...(template_id ? { template_id } : {}),
    });

    if (!sendFailed) {
      // Update cooldown timestamp
      await supabase
        .from("players")
        .update({ last_outbound_at: sentAt })
        .eq("id", player.id);
      sent++;
      req.log.info({ player_id: player.id, template_id }, "Bulk SMS sent");
    }

    await delay(100);
  }

  res.json({ sent, skipped_cooldown, failed, errors });
});

// ─── POST /api/messages/webhook/status ───────────────────────────────────────
// Twilio calls this for delivery status AND link click events.
// Body is application/x-www-form-urlencoded (already parsed by app.ts).

router.post("/messages/webhook/status", async (req, res) => {
  const { MessageSid, MessageStatus, ErrorCode, ErrorMessage, event } =
    req.body as Record<string, string>;

  const messageSid = MessageSid;
  if (!messageSid) {
    res.status(400).send("Missing MessageSid");
    return;
  }

  req.log.info({ MessageSid, MessageStatus, event }, "Twilio status webhook received");

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

  if (MessageStatus === "delivered") {
    update.delivered_at = new Date().toISOString();
  } else if (MessageStatus === "failed" || MessageStatus === "undelivered") {
    update.status = MessageStatus;
    if (ErrorCode) update.error_code = ErrorCode;
    if (ErrorMessage) update.error_message = ErrorMessage;
  }

  await supabase
    .from("messages")
    .update(update)
    .eq("twilio_message_sid", messageSid);

  res.status(204).send();
});

// ─── POST /api/messages/webhook/inbound ──────────────────────────────────────
// Twilio posts here when a member replies or sends STOP.
// Configure in Twilio Console → Phone Numbers → your number
//   "A message comes in" → Webhook → POST → https://yourdomain.com/api/messages/webhook/inbound

router.post("/messages/webhook/inbound", async (req, res) => {
  const { From, Body } = req.body as { From?: string; Body?: string };

  if (!From || !Body) {
    res.status(400).send("Missing From or Body");
    return;
  }

  const bodyNorm = Body.trim().toLowerCase();
  const isStop = STOP_KEYWORDS.has(bodyNorm);
  const isStart = START_KEYWORDS.has(bodyNorm);

  req.log.info({ from: From, body: Body, isStop, isStart }, "Inbound SMS received");

  // Look up player by phone — try with and without leading +1
  const { data: player } = await supabase
    .from("players")
    .select("id, name, sms_opt_in, club_id")
    .or(`phone.eq.${From},phone.eq.${From.replace(/^\+1/, "")}`)
    .limit(1)
    .maybeSingle();

  if (!player) {
    // Unknown number — must still honor STOP for TCPA compliance, but nothing to update
    req.log.warn({ from: From }, "Inbound SMS from unknown number");
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send("<Response></Response>");
    return;
  }

  // ── STOP: opt out ──
  if (isStop) {
    await supabase
      .from("players")
      .update({ sms_opt_in: false })
      .eq("id", player.id);

    // Cancel all pending queued messages for this player
    const { data: convs } = await supabase
      .from("conversations")
      .select("id")
      .eq("player_id", player.id);

    if (convs?.length) {
      await supabase
        .from("messages")
        .update({ status: "skipped", error_message: "Player opted out via STOP" })
        .in("conversation_id", convs.map((c: any) => c.id))
        .eq("status", "pending");
    }

    req.log.info({ player_id: player.id }, "Player opted out via STOP");
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send("<Response></Response>");
    return;
  }

  // ── START: re-subscribe ──
  if (isStart) {
    await supabase
      .from("players")
      .update({ sms_opt_in: true })
      .eq("id", player.id);

    req.log.info({ player_id: player.id }, "Player re-subscribed via START");
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send("<Response></Response>");
    return;
  }

  // ── Regular reply: thread into most recent conversation ──
  const { data: recentConv } = await supabase
    .from("conversations")
    .select("id")
    .eq("player_id", player.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let conversationId = recentConv?.id;

  if (!conversationId) {
    const { data: newConv } = await supabase
      .from("conversations")
      .insert({ player_id: player.id, club_id: player.club_id, triggered_by: "inbound" })
      .select("id")
      .single();
    conversationId = newConv?.id;
  }

  await supabase.from("messages").insert({
    conversation_id: conversationId,
    body: Body,
    direction: "inbound",
    sent_by: "player",
    status: "sent",
  });

  req.log.info({ player_id: player.id, conversation_id: conversationId }, "Inbound reply captured");

  // No auto-reply — operator handles manually
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send("<Response></Response>");
});

export default router;

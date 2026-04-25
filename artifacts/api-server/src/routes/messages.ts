import { Router, type IRouter } from "express";
import twilio from "twilio";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const router: IRouter = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  }
  return twilio(accountSid, authToken);
}

const SendSchema = z.object({
  message_id: z.string().uuid("message_id must be a valid UUID"),
});

// POST /api/messages/send
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

  // 1. Look up the message
  const { data: message, error: msgErr } = await supabase
    .from("messages")
    .select("id, body, signup_url, conversation_id")
    .eq("id", message_id)
    .single();

  if (msgErr || !message) {
    res.status(404).json({ error: "Message not found", detail: msgErr?.message });
    return;
  }

  // 2. Look up the conversation to get player_id
  const { data: conversation, error: convErr } = await supabase
    .from("conversations")
    .select("player_id")
    .eq("id", message.conversation_id)
    .single();

  if (convErr || !conversation) {
    res.status(404).json({ error: "Conversation not found", detail: convErr?.message });
    return;
  }

  // 3. Look up the player to get phone number
  const { data: player, error: playerErr } = await supabase
    .from("players")
    .select("id, phone, name")
    .eq("id", conversation.player_id)
    .single();

  if (playerErr || !player) {
    res.status(404).json({ error: "Player not found", detail: playerErr?.message });
    return;
  }

  if (!player.phone) {
    res.status(422).json({ error: "Player has no phone number on record" });
    return;
  }

  // 4. Build message body — append signup URL if present
  const smsBody = message.signup_url
    ? `${message.body}\n${message.signup_url}`
    : message.body;

  // 5. Send via Twilio
  const client = getTwilioClient();
  const from = process.env.TWILIO_PHONE_NUMBER;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  // Build the status callback URL for delivery + click tracking
  const statusCallbackUrl = process.env.PUBLIC_API_URL
    ? `${process.env.PUBLIC_API_URL}/api/messages/webhook/status`
    : undefined;

  let twilioMessage;
  try {
    const params: Record<string, any> = {
      body: smsBody,
      to: player.phone,
      ...(statusCallbackUrl ? { statusCallback: statusCallbackUrl } : {}),
    };

    if (messagingServiceSid) {
      // Messaging Service enables shortenUrls / click tracking
      params.messagingServiceSid = messagingServiceSid;
      params.shortenUrls = true;
    } else {
      params.from = from;
    }

    twilioMessage = await client.messages.create(params);
  } catch (err: unknown) {
    req.log.error({ err }, "Twilio send failed");
    res.status(502).json({
      error: "Failed to send SMS",
      detail: err instanceof Error ? err.message : "Unknown error",
    });
    return;
  }

  // 6. Store the Twilio SID back on the message record
  const { error: updateErr } = await supabase
    .from("messages")
    .update({ twilio_message_sid: twilioMessage.sid })
    .eq("id", message_id);

  if (updateErr) {
    req.log.warn({ err: updateErr }, "Message sent but failed to store twilio_message_sid");
  }

  req.log.info({ message_id, twilio_sid: twilioMessage.sid, to: player.phone }, "SMS sent");

  res.json({
    success: true,
    twilio_sid: twilioMessage.sid,
    to: player.phone,
  });
});

// POST /api/messages/webhook/status
// Twilio calls this for delivery status changes and link click events.
// Body is application/x-www-form-urlencoded.
router.post("/messages/webhook/status", async (req, res) => {
  const {
    MessageSid,
    MessageStatus,
    // Link click events from Twilio shortened URLs
    event,
  } = req.body as Record<string, string>;

  req.log.info({ MessageSid, MessageStatus, event }, "Twilio status webhook received");

  const isClick =
    MessageStatus === "clicked" ||
    event === "link_click" ||
    event === "clicked";

  if (MessageSid && isClick) {
    // Find the message by twilio_message_sid and mark link as clicked
    const { error } = await supabase
      .from("messages")
      .update({
        link_clicked: true,
        link_clicked_at: new Date().toISOString(),
      })
      .eq("twilio_message_sid", MessageSid);

    if (error) {
      req.log.error({ err: error, MessageSid }, "Failed to update link_clicked on message");
    } else {
      req.log.info({ MessageSid }, "Link click recorded on message");
    }
  }

  // Twilio expects a 204 or 200 with empty/TwiML body
  res.status(204).send();
});

// POST /api/messages/bulk
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

  // Fetch players (only those with sms_opt_in = true from the given IDs)
  const { data: players, error: fetchErr } = await supabase
    .from("players")
    .select("id, name, skill_level, last_visit_date, phone, club_id, sms_opt_in")
    .in("id", player_ids)
    .eq("sms_opt_in", true);

  if (fetchErr) {
    res.status(500).json({ error: "Failed to fetch players", detail: fetchErr.message });
    return;
  }

  const eligible = (players ?? []).filter((p: any) => p.phone);

  if (eligible.length === 0) {
    res.json({ sent: 0, failed: 0, errors: [] });
    return;
  }

  const club_id: string | null = eligible[0]?.club_id ?? null;

  let twilioClient: ReturnType<typeof getTwilioClient> | null = null;
  try {
    twilioClient = getTwilioClient();
  } catch {
    // Twilio not configured — log messages only
  }

  const from = process.env.TWILIO_PHONE_NUMBER;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      .replace(/\{\{first_name\}\}/g, firstName)
      .replace(/\{\{skill_level\}\}/g, skillLevel)
      .replace(/\{\{last_visit\}\}/g, lastVisit)
      .replace(/\{\{club_name\}\}/g, "PB Club");
  }

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const player of eligible) {
    const interpolated = interpolate(message_body, player);

    // Create conversation record
    const { data: convData, error: convErr } = await supabase
      .from("conversations")
      .insert({
        player_id: player.id,
        club_id,
        triggered_by: "bulk",
      })
      .select("id")
      .single();

    if (convErr || !convData) {
      req.log.error({ err: convErr, player_id: player.id }, "Bulk: failed to create conversation");
      failed++;
      errors.push(player.id);
      continue;
    }

    const conversation_id: string = convData.id;

    // Send via Twilio (if configured)
    let twilio_message_sid: string | null = null;
    if (twilioClient) {
      try {
        const params: Record<string, any> = {
          body: interpolated,
          to: player.phone,
        };
        if (messagingServiceSid) {
          params.messagingServiceSid = messagingServiceSid;
        } else if (from) {
          params.from = from;
        }
        const twilioMsg = await twilioClient.messages.create(params);
        twilio_message_sid = twilioMsg.sid;
      } catch (err) {
        req.log.error({ err, player_id: player.id }, "Bulk: Twilio send failed");
        failed++;
        errors.push(player.id);
        // Still log the message attempt
      }
    }

    // Insert message record
    const { error: msgErr } = await supabase.from("messages").insert({
      conversation_id,
      body: interpolated,
      direction: "outbound",
      sent_by: "operator",
      ...(twilio_message_sid ? { twilio_message_sid } : {}),
    });

    if (msgErr) {
      req.log.warn({ err: msgErr, player_id: player.id }, "Bulk: failed to insert message record");
    }

    if (!errors.includes(player.id)) {
      sent++;
      req.log.info({ player_id: player.id, template_id }, "Bulk SMS sent");
    }

    await delay(100);
  }

  res.json({ sent, failed, errors });
});

export default router;

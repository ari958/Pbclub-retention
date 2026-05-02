import { supabase } from "./supabaseClient";
import { sendViaTwilio } from "./twilio";
import { extractSkillLevel, isFeedbackLevel } from "./skillLevel";
import { logger } from "./logger";

const PODPLAY_BASE = "https://pbclub.podplay.app/apis/v2";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildFeedbackMessage(firstName: string, level: string): string {
  return (
    `Hi ${firstName}! Quick question about today's ${level} session 🎾\n\n` +
    `1️⃣ Did you feel like YOU belonged at this level?\n` +
    `2️⃣ Did the OTHER players belong at this level?\n\n` +
    `Reply with 2 numbers — e.g. 'Y Y', 'Y N', 'N Y', or 'N N'`
  );
}

/**
 * Parse a two-part feedback reply.
 * First token = self_fit, second token = others_fit.
 * Accepts: Y/N, YES/NO, 1/2 (case-insensitive).
 * Returns null if the reply cannot be parsed into exactly two valid answers.
 */
export function parseFeedbackReply(body: string): { self_fit: 0 | 1; others_fit: 0 | 1 } | null {
  const tokens = body.trim().toLowerCase().split(/[\s,/|]+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const parse = (t: string): 0 | 1 | null => {
    if (t === "y" || t === "1" || t === "yes") return 1;
    if (t === "n" || t === "2" || t === "no") return 0;
    return null;
  };

  const self_fit = parse(tokens[0]);
  const others_fit = parse(tokens[1]);
  if (self_fit === null || others_fit === null) return null;
  return { self_fit, others_fit };
}

// ─── PodPlay fetchers ─────────────────────────────────────────────────────────

async function fetchEventById(eventId: string): Promise<any> {
  const res = await fetch(`${PODPLAY_BASE}/events/${eventId}`, {
    headers: { "x-api-key": process.env.PODPLAY_API_KEY ?? "" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`PodPlay GET /events/${eventId} returned ${res.status}`);
  return res.json();
}

async function fetchEventsEndingInWindow(windowStartMs: number, windowEndMs: number): Promise<any[]> {
  // Search 4h back for start times so we catch 1-3h sessions that end within our window
  const from = new Date(windowStartMs - 4 * 60 * 60 * 1000).toISOString();
  const to = new Date(windowEndMs).toISOString();
  const url =
    `${PODPLAY_BASE}/events` +
    `?startTime=${encodeURIComponent(from)}&endTime=${encodeURIComponent(to)}&ipp=100`;

  const res = await fetch(url, {
    headers: { "x-api-key": process.env.PODPLAY_API_KEY ?? "" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`PodPlay events fetch returned ${res.status}`);
  const data = (await res.json()) as { items?: any[] };

  return (data.items ?? []).filter((ev: any) => {
    if (!ev.endTime) return false;
    const endMs = new Date(ev.endTime).getTime();
    return endMs >= windowStartMs && endMs <= windowEndMs;
  });
}

// ─── Core send logic ──────────────────────────────────────────────────────────

export async function sendFeedbackForEvent(
  eventId: string,
  log: (msg: string) => void = (m) => logger.info(m)
): Promise<{ sent: number; skipped: number; errors: number }> {
  const stats = { sent: 0, skipped: 0, errors: 0 };

  // Fetch event from PodPlay
  let event: any;
  try {
    event = await fetchEventById(eventId);
  } catch (err: any) {
    log(`[feedback] Cannot fetch event ${eventId}: ${err.message}`);
    stats.errors++;
    return stats;
  }

  // Only send for events with a specific skill level
  const level = extractSkillLevel(event.tags);
  if (!isFeedbackLevel(level)) {
    log(`[feedback] Event ${eventId} "${event.name}" — level="${level ?? "none"}" is not feedbackable — skipping`);
    stats.skipped++;
    return stats;
  }

  // Idempotency: skip if feedback texts already sent for this event
  const { data: existingSends } = await supabase
    .from("pending_sends")
    .select("id")
    .eq("type", "session_feedback")
    .eq("metadata->>event_id", eventId)
    .limit(1);

  if (existingSends && existingSends.length > 0) {
    log(`[feedback] Event ${eventId} — feedback already sent — skipping`);
    stats.skipped++;
    return stats;
  }

  // Get all player_ids that attended this event
  const { data: attRows, error: attErr } = await supabase
    .from("attendances")
    .select("player_id")
    .eq("event_id", eventId);

  if (attErr) {
    log(`[feedback] Error fetching attendees for event ${eventId}: ${attErr.message}`);
    stats.errors++;
    return stats;
  }

  const playerIds = [
    ...new Set((attRows ?? []).map((a: any) => a.player_id as string).filter(Boolean)),
  ];

  if (playerIds.length === 0) {
    log(`[feedback] Event ${eventId} — no attendance records found — skipping`);
    stats.skipped++;
    return stats;
  }

  // Fetch player details (chunked to avoid IN() limits)
  const eligible: any[] = [];
  for (let i = 0; i < playerIds.length; i += 500) {
    const chunk = playerIds.slice(i, i + 500);
    const { data: players } = await supabase
      .from("players")
      .select("id, name, phone, sms_opt_in, club_id, last_outbound_at")
      .in("id", chunk)
      .not("phone", "is", null)
      .neq("sms_opt_in", false);
    eligible.push(...(players ?? []));
  }

  log(
    `[feedback] Event ${eventId} "${event.name}" — level: ${level} — ` +
    `${eligible.length} eligible / ${playerIds.length} total attendees`
  );

  const twilioAvailable = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);

  for (const player of eligible) {
    const firstName = (player.name as string).split(" ")[0];
    const messageBody = buildFeedbackMessage(firstName, level!);

    try {
      // Create a conversation tagged as session_feedback
      const { data: conv, error: convErr } = await supabase
        .from("conversations")
        .insert({ player_id: player.id, club_id: player.club_id, triggered_by: "session_feedback" })
        .select("id")
        .single();

      if (convErr || !conv) {
        log(`[feedback] Failed to create conversation for player ${player.id}: ${convErr?.message}`);
        stats.errors++;
        continue;
      }

      let twilio_sid: string | null = null;
      const sentAt = new Date().toISOString();

      if (twilioAvailable) {
        try {
          twilio_sid = await sendViaTwilio(player.phone, messageBody);
        } catch (err: any) {
          log(`[feedback] Twilio send failed for player ${player.id}: ${err.message}`);
          stats.errors++;
          continue;
        }
      }

      // Record the outbound message
      await supabase.from("messages").insert({
        conversation_id: conv.id,
        body: messageBody,
        direction: "outbound",
        sent_by: "system",
        status: twilio_sid ? "sent" : "pending",
        ...(twilio_sid ? { twilio_message_sid: twilio_sid, sent_at: sentAt } : {}),
      });

      // Register in pending_sends so the inbound handler can route the reply
      await supabase.from("pending_sends").insert({
        player_id: player.id,
        type: "session_feedback",
        metadata: { event_id: eventId, level },
        conversation_id: conv.id,
      });

      // Advance cooldown timestamp
      await supabase.from("players").update({ last_outbound_at: sentAt }).eq("id", player.id);

      stats.sent++;
    } catch (err: any) {
      log(`[feedback] Error sending to player ${player.id}: ${err.message}`);
      stats.errors++;
    }
  }

  log(`[feedback] Event ${eventId} done — sent: ${stats.sent} skipped: ${stats.skipped} errors: ${stats.errors}`);
  return stats;
}

export async function sendFeedbackForRecentEvents(
  log: (msg: string) => void = (m) => logger.info(m),
  windowHours = 2
): Promise<{ eventsFound: number; totalSent: number; totalSkipped: number; totalErrors: number }> {
  const now = Date.now();
  const windowStart = now - windowHours * 60 * 60 * 1000;

  let events: any[];
  try {
    events = await fetchEventsEndingInWindow(windowStart, now);
  } catch (err: any) {
    log(`[feedback] Failed to fetch recent events: ${err.message}`);
    return { eventsFound: 0, totalSent: 0, totalSkipped: 0, totalErrors: 1 };
  }

  log(`[feedback] Found ${events.length} events ending in last ${windowHours}h`);

  let totalSent = 0, totalSkipped = 0, totalErrors = 0;
  for (const ev of events) {
    const s = await sendFeedbackForEvent(ev.id, log);
    totalSent += s.sent;
    totalSkipped += s.skipped;
    totalErrors += s.errors;
  }

  log(
    `[feedback] All events processed — ` +
    `events: ${events.length} sent: ${totalSent} skipped: ${totalSkipped} errors: ${totalErrors}`
  );
  return { eventsFound: events.length, totalSent, totalSkipped, totalErrors };
}

/**
 * Post-session feedback dispatcher.
 *
 * Polls every 30 minutes for sessions ending in the last 30 minutes and queues
 * a "did everyone belong at this level?" feedback prompt to each attendee.
 */
import { supabase } from "./supabaseClient";
import { recordSmsDispatchFailure, sendViaTwilio } from "./twilio";
import { isRetentionOnlyMode } from "./retentionPolicy";
import { extractSkillLevel, isFeedbackLevel } from "./skillLevel";
import { logger } from "./logger";
import { expectReply, findActiveExpectation } from "./replyExpectations";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FEEDBACK_FALLBACK =
  "Hi {{first_name}}! Quick question about today's {{level}} session 🎾\n\n" +
  "1️⃣ Did you feel like YOU belonged at this level?\n" +
  "2️⃣ Did the OTHER players belong at this level?\n\n" +
  "Reply with 2 answers — e.g. 'Y Y', 'Y N', 'N Y', or 'N N'";

async function getFeedbackTemplate(clubId: string): Promise<string> {
  const { data } = await supabase
    .from("message_templates")
    .select("body")
    .eq("club_id", clubId)
    .contains("use_case_tags", ["session_feedback"])
    .limit(1)
    .maybeSingle();
  return data?.body ?? FEEDBACK_FALLBACK;
}

/**
 * Parse a two-part feedback reply.
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

async function fetchEventById(eventId: string, podplayBase: string, apiKey: string): Promise<any> {
  const res = await fetch(`${podplayBase}/apis/v2/events/${eventId}`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`PodPlay GET /events/${eventId} returned ${res.status}`);
  return res.json();
}

async function fetchEventsEndingInWindow(
  windowStartMs: number,
  windowEndMs: number,
  podplayBase: string,
  apiKey: string,
): Promise<any[]> {
  const from = new Date(windowStartMs - 4 * 60 * 60 * 1000).toISOString();
  const to = new Date(windowEndMs).toISOString();
  const url =
    `${podplayBase}/apis/v2/events` +
    `?startTime=${encodeURIComponent(from)}&endTime=${encodeURIComponent(to)}&ipp=100`;

  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
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

// ─── Resolve PodPlay credentials (DB-first, env fallback) ────────────────────

async function resolveCredentials(
  clubId: string | undefined,
  log: (msg: string) => void = (m) => logger.info(m),
): Promise<{ podplayBase: string; apiKey: string }> {
  let row: { platform_subdomain: string | null; platform_api_key: string | null } | null = null;

  if (clubId) {
    const { data } = await supabase
      .from("clubs")
      .select("platform_api_key, platform_subdomain")
      .eq("id", clubId)
      .maybeSingle();
    row = data;
    if (!row) throw new Error(`No club found for id=${clubId}`);
  } else {
    // Transitional backward compat: scheduler doesn't pass clubId yet (Step 7).
    const { data } = await supabase
      .from("clubs")
      .select("platform_api_key, platform_subdomain")
      .limit(1)
      .maybeSingle();
    row = data;
    if (!row?.platform_subdomain) throw new Error("No club platform_subdomain available for PodPlay requests");
  }

  if (!row.platform_subdomain) throw new Error(`Club ${clubId} has no platform_subdomain configured`);
  const apiKey = row.platform_api_key ?? process.env.PODPLAY_API_KEY ?? "";
  if (!row.platform_api_key) {
    log(`[podplay] Using env-var fallback for API key — backfill clubs.platform_api_key for club ${clubId}`);
  }
  return { podplayBase: `https://${row.platform_subdomain}.podplay.app`, apiKey };
}

// ─── Core send logic ──────────────────────────────────────────────────────────

export async function sendFeedbackForEvent(
  eventId: string,
  clubId?: string,
  log: (msg: string) => void = (m) => logger.info(m),
): Promise<{ sent: number; skipped: number; errors: number }> {
  const stats = { sent: 0, skipped: 0, errors: 0 };
  if (isRetentionOnlyMode()) {
    log("[feedback] Legacy post-session feedback is parked by RETENTION_ONLY_MODE");
    return { ...stats, skipped: 1 };
  }

  let podplayBase: string;
  let apiKey: string;
  try {
    ({ podplayBase, apiKey } = await resolveCredentials(clubId, log));
  } catch (err: any) {
    log(`[feedback] Could not resolve PodPlay credentials: ${err.message}`);
    stats.errors++;
    return stats;
  }

  let event: any;
  try {
    event = await fetchEventById(eventId, podplayBase, apiKey);
  } catch (err: any) {
    log(`[feedback] Cannot fetch event ${eventId}: ${err.message}`);
    stats.errors++;
    return stats;
  }

  const level = extractSkillLevel(event.tags);
  if (!isFeedbackLevel(level)) {
    log(`[feedback] Event ${eventId} "${event.name}" — level="${level ?? "none"}" is not feedbackable — skipping`);
    stats.skipped++;
    return stats;
  }

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

  const eligible: any[] = [];
  for (let i = 0; i < playerIds.length; i += 100) {
    const chunk = playerIds.slice(i, i + 100);
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

  const eventClubId: string = eligible[0]?.club_id ?? "";
  const templateBody = await getFeedbackTemplate(eventClubId);
  const twilioAvailable = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);

  for (const player of eligible) {
    const existing = await findActiveExpectation(player.id, "session_feedback");
    if (existing && (existing.metadata as { event_id?: string })?.event_id === eventId) {
      continue;
    }
    const firstName = (player.name as string).split(" ")[0];
    const messageBody = templateBody
      .replace(/\{\{first_name\}\}/g, firstName)
      .replace(/\{\{level\}\}/g, level!);

    try {
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

      const { data: msgRow, error: msgInsertErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conv.id,
          player_id: player.id,
          body: messageBody,
          direction: "outbound",
          sent_by: "system",
          status: "pending",
          sent_at: null,
        })
        .select("id")
        .single();

      if (msgInsertErr || !msgRow) {
        log(`[feedback] Failed to insert message row for player ${player.id}: ${msgInsertErr?.message}`);
        stats.errors++;
        continue;
      }

      const sentAt = new Date().toISOString();

      if (twilioAvailable) {
        try {
          const twilio_sid = await sendViaTwilio(player.phone, messageBody);
          await supabase
            .from("messages")
            .update({ twilio_message_sid: twilio_sid, status: "sent", sent_at: sentAt })
            .eq("id", msgRow.id);
        } catch (err: any) {
          log(`[feedback] Twilio send failed for player ${player.id}: ${err.message}`);
          await recordSmsDispatchFailure(err);
          stats.errors++;
          continue;
        }
      }

      await expectReply({
        playerId: player.id,
        kind: "session_feedback",
        metadata: { event_id: eventId, level },
        conversationId: conv.id,
      });

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
  clubId?: string,
  log: (msg: string) => void = (m) => logger.info(m),
  windowHours = 2,
): Promise<{ eventsFound: number; totalSent: number; totalSkipped: number; totalErrors: number }> {
  if (isRetentionOnlyMode()) {
    log("[feedback] Legacy post-session feedback scheduler is parked by RETENTION_ONLY_MODE");
    return { eventsFound: 0, totalSent: 0, totalSkipped: 0, totalErrors: 0 };
  }
  const now = Date.now();
  const windowStart = now - windowHours * 60 * 60 * 1000;

  let podplayBase: string;
  let apiKey: string;
  try {
    ({ podplayBase, apiKey } = await resolveCredentials(clubId, log));
  } catch (err: any) {
    log(`[feedback] Could not resolve PodPlay credentials: ${err.message}`);
    return { eventsFound: 0, totalSent: 0, totalSkipped: 0, totalErrors: 1 };
  }

  let events: any[];
  try {
    events = await fetchEventsEndingInWindow(windowStart, now, podplayBase, apiKey);
  } catch (err: any) {
    log(`[feedback] Failed to fetch recent events: ${err.message}`);
    return { eventsFound: 0, totalSent: 0, totalSkipped: 0, totalErrors: 1 };
  }

  log(`[feedback] Found ${events.length} events ending in last ${windowHours}h`);

  let totalSent = 0, totalSkipped = 0, totalErrors = 0;
  for (const ev of events) {
    const s = await sendFeedbackForEvent(ev.id, clubId, log);
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

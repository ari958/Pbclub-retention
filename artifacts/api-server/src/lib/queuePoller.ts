import { supabase } from "./supabaseClient";
import { sendViaTwilio } from "./twilio";
import { sanitizeScheduledSendAt } from "./playerTiming";
import { logger } from "./logger";

const POLL_INTERVAL_MS =
  parseInt(process.env.POLL_INTERVAL_MS ?? "", 10) || 5 * 60 * 1000;
const BATCH_LIMIT = 50;

// ─── TCPA window helper ────────────────────────────────────────────────────────
// Mirrors the window logic inside sanitizeScheduledSendAt so we can determine
// whether now() is inside the window WITHOUT calling sanitize with now() directly.
// (Calling sanitize(now()) inside the window returns null because the result
// equals now(), which fails the "past → skip" guard at the end of that function.)

function isInsideTcpaWindow(date: Date): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      weekday: "short",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const localHour =
    (parseInt(parts.hour, 10) % 24) + parseInt(parts.minute, 10) / 60;
  const isWeekend = parts.weekday === "Sat" || parts.weekday === "Sun";
  const openHour = isWeekend ? 8.5 : 8.0;
  return localHour >= openHour && localHour <= 19.5;
}

// ─── One tick ─────────────────────────────────────────────────────────────────

export interface QueueTickStats {
  processed: number;
  sent: number;
  rolled: number;
  skipped: number;
  failed: number;
}

export async function runQueueTick(): Promise<QueueTickStats> {
  const stats: QueueTickStats = {
    processed: 0,
    sent: 0,
    rolled: 0,
    skipped: 0,
    failed: 0,
  };

  const { data: rows, error } = await supabase
    .from("messages")
    .select("id, player_id, body, players!inner(phone)")
    .eq("status", "pending")
    .not("scheduled_send_at", "is", null)
    .lte("scheduled_send_at", new Date().toISOString())
    .order("scheduled_send_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    logger.error({ err: error.message }, "[queue] Batch SELECT failed");
    return stats;
  }

  const messages = rows ?? [];
  if (messages.length === 0) return stats;

  logger.info({ count: messages.length }, "[queue] tick — messages due");

  for (const row of messages) {
    stats.processed++;
    const id = row.id as string;
    const player_id = row.player_id as string;
    const body = row.body as string;
    const phone = (row.players as any)?.phone as string | null;

    try {
      // ── a. TCPA WINDOW ──────────────────────────────────────────────────────
      const tickNow = new Date();
      if (!isInsideTcpaWindow(tickNow)) {
        const nextWindow = sanitizeScheduledSendAt(tickNow);
        if (nextWindow === null) {
          // Defensive: should not happen when now() is outside the window,
          // but guard it rather than writing null back.
          logger.info({ id }, "[queue] sanitize returned null, leaving as-is");
          continue;
        }
        await supabase
          .from("messages")
          .update({ scheduled_send_at: nextWindow.toISOString() })
          .eq("id", id);
        logger.info(
          { id, nextWindow: nextWindow.toISOString() },
          `[queue] rolled ${id} to ${nextWindow.toISOString()} (outside TCPA window)`,
        );
        stats.rolled++;
        continue;
      }

      // ── b. OPT-OUT RE-CHECK (dispatch-time safety net) ─────────────────────
      const { data: playerRow, error: playerErr } = await supabase
        .from("players")
        .select("sms_opt_in")
        .eq("id", player_id)
        .single();

      if (playerErr || !playerRow) {
        throw new Error(
          playerErr?.message ?? "Player not found at dispatch time",
        );
      }

      if (!playerRow.sms_opt_in) {
        await supabase
          .from("messages")
          .update({
            status: "skipped",
            error_message: "Player opted out (dispatch-time re-check)",
          })
          .eq("id", id);
        logger.info({ id, player_id }, "[queue] skipped — opted out");
        stats.skipped++;
        continue;
      }

      // ── Guard: no phone ─────────────────────────────────────────────────────
      if (!phone) {
        await supabase
          .from("messages")
          .update({
            status: "skipped",
            error_message: "No phone number at dispatch time",
          })
          .eq("id", id);
        logger.info({ id, player_id }, "[queue] skipped — no phone");
        stats.skipped++;
        continue;
      }

      // ── c. DISPATCH — reuses /send persistence path exactly ─────────────────
      const { sid, simulated } = await sendViaTwilio(phone, body);
      const sentAt = new Date().toISOString();

      await Promise.all([
        supabase
          .from("messages")
          .update({
            status: "sent",
            twilio_message_sid: sid,
            simulated,
            sent_at: sentAt,
          })
          .eq("id", id),
        supabase
          .from("players")
          .update({ last_outbound_at: sentAt })
          .eq("id", player_id),
      ]);

      logger.info({ id, player_id, twilio_sid: sid, simulated }, "[queue] sent");
      stats.sent++;
    } catch (err: any) {
      logger.error({ err, id, player_id }, "[queue] dispatch error");
      await supabase
        .from("messages")
        .update({
          status: "failed",
          error_message: err?.message ?? "Unknown dispatch error",
        })
        .eq("id", id);
      stats.failed++;
    }
  }

  logger.info(stats, "[queue] tick complete");
  return stats;
}

// ─── Poller ───────────────────────────────────────────────────────────────────

export function startQueuePoller(): void {
  let running = false;

  logger.info(
    { intervalMs: POLL_INTERVAL_MS },
    "[queue] Queue poller started",
  );

  setInterval(async () => {
    if (running) {
      logger.info("[queue] tick still running — skipping");
      return;
    }
    running = true;
    try {
      await runQueueTick();
    } catch (err) {
      logger.error({ err }, "[queue] tick uncaught error");
    } finally {
      running = false;
    }
  }, POLL_INTERVAL_MS);
}

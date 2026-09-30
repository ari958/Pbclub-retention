import { supabase } from "./supabaseClient";
import {
  composeApprovedMessageBody,
  isSmsDispatchClaimError,
  isSmsPolicyBlockedError,
  recordSmsDispatchFailure,
  sendViaTwilio,
} from "./twilio";
import { sanitizeScheduledSendAt, isInsideSendWindow } from "./playerTiming";
import { logger } from "./logger";
import { isRetentionOnlyMode, isTextEligible, requiresMarketingConsent } from "./retentionPolicy";

const POLL_INTERVAL_MS =
  parseInt(process.env.POLL_INTERVAL_MS ?? "", 10) || 5 * 60 * 1000;
const BATCH_LIMIT = 50;

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
    .select("id, player_id, body, signup_url, players!inner(phone)")
    .eq("status", "pending")
    .not("approved_at", "is", null)
    .neq("approved_by", "")
    .not("approved_body", "is", null)
    .neq("approved_body", "")
    .is("dispatch_claimed_at", null)
    .is("dispatch_token", null)
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
    const smsBody = composeApprovedMessageBody(body, row.signup_url as string | null);
    const phone = (row.players as any)?.phone as string | null;

    try {
      // ── a. TCPA WINDOW ──────────────────────────────────────────────────────
      const tickNow = new Date();
      if (!isInsideSendWindow(tickNow)) {
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
          .eq("id", id)
          .eq("status", "pending")
          .is("dispatch_claimed_at", null)
          .is("dispatch_token", null);
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
        .select("phone, opted_out, sms_opt_in, consent_source, sms_consented_at")
        .eq("id", player_id)
        .single();

      if (playerErr || !playerRow) {
        throw new Error(
          playerErr?.message ?? "Player not found at dispatch time",
        );
      }

      const eligible = !isRetentionOnlyMode() && requiresMarketingConsent()
        ? isTextEligible(playerRow)
        : !!playerRow.phone?.trim() && playerRow.opted_out !== true;
      if (!eligible) {
        await supabase
          .from("messages")
          .update({
            status: "skipped",
            error_message: "Player opted out (dispatch-time re-check)",
          })
          .eq("id", id)
          .eq("status", "pending")
          .is("dispatch_claimed_at", null)
          .is("dispatch_token", null);
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
          .eq("id", id)
          .eq("status", "pending")
          .is("dispatch_claimed_at", null)
          .is("dispatch_token", null);
        logger.info({ id, player_id }, "[queue] skipped — no phone");
        stats.skipped++;
        continue;
      }

      // ── c. DISPATCH — reuses /send persistence path exactly ─────────────────
      const { sid, simulated, isTest } = await sendViaTwilio(phone, smsBody, {
        messageId: id,
        source: "queue",
        purpose: "promotion",
      });

      logger.info({ id, twilio_sid: sid, simulated, isTest }, "[queue] sent");
      stats.sent++;
    } catch (err: any) {
      logger.error({ err, id, player_id }, "[queue] dispatch error");
      if (isSmsPolicyBlockedError(err) || isSmsDispatchClaimError(err)) {
        stats.skipped++;
        continue;
      }
      await recordSmsDispatchFailure(err);
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

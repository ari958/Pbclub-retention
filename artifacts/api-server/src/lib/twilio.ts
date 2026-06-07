import twilio from "twilio";
import { logger } from "./logger";

export function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  }
  return twilio(accountSid, authToken);
}

/**
 * Send an SMS via Twilio (live) or log a dry-run (when SMS_LIVE !== "true").
 *
 * Gate order:
 *   1. Resolve original recipient.
 *   2. Apply SMS_TEST_OVERRIDE_TO (if set) — redirects the Twilio `to` field
 *      only; the messages row still records the original player's data.
 *   3. Check SMS_LIVE: if not "true", log payload and return synthetic result.
 *      If "true", call client.messages.create.
 *
 * Returns { sid, simulated } so callers can persist the simulated flag alongside
 * twilio_message_sid without any conditional logic of their own.
 */
export async function sendViaTwilio(
  to: string,
  body: string,
): Promise<{ sid: string; simulated: boolean }> {
  const smsLive   = process.env.SMS_LIVE === "true";
  const overrideTo = (process.env.SMS_TEST_OVERRIDE_TO ?? "").trim();

  const effectiveTo = overrideTo || to;
  if (overrideTo) {
    logger.info(
      { original: to, redirected: effectiveTo },
      "[SMS OVERRIDE] original=%s redirected=%s",
    );
  }

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  // TWILIO_PHONE_NUMBER is the canonical from-number env var.
  // clubs.twilio_number exists in the DB but is intentionally unused here;
  // per-club Twilio numbers are a future milestone.
  const from = process.env.TWILIO_PHONE_NUMBER;
  const statusCallbackUrl = process.env.PUBLIC_API_URL
    ? `${process.env.PUBLIC_API_URL}/api/messages/webhook/status`
    : undefined;

  if (!smsLive) {
    logger.info(
      {
        to: effectiveTo,
        originalTo: to,
        from: messagingServiceSid ?? from ?? "(none)",
        body,
        path: messagingServiceSid ? "messaging-service" : "from-number",
      },
      "[SMS DRY-RUN] would send message — set SMS_LIVE=true to go live",
    );
    return { sid: "SIMULATED", simulated: true };
  }

  const client = getTwilioClient();
  let msg;
  if (messagingServiceSid) {
    msg = await client.messages.create({
      body,
      to: effectiveTo,
      messagingServiceSid,
      shortenUrls: true,
      ...(statusCallbackUrl ? { statusCallback: statusCallbackUrl } : {}),
    });
  } else {
    msg = await client.messages.create({
      body,
      to: effectiveTo,
      from: from!,
      ...(statusCallbackUrl ? { statusCallback: statusCallbackUrl } : {}),
    });
  }
  return { sid: msg.sid, simulated: false };
}

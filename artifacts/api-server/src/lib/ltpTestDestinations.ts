import twilio from "twilio";

export interface LtpSentMessage { id: string; twilio_message_sid: string | null; status: string; sent_at: string | null }
export interface LtpDestinationEvidence { message_id: string; twilio_message_sid: string; to: string }
const phone = (value: string) => {
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 ? `1${digits}` : digits;
};

/** Twilio's stored outbound record, not the player's phone or today's flag. */
export async function verifyStoredLtpDestinations(
  messages: LtpSentMessage[], override: string,
  readStored: (sid: string) => Promise<{ sid: string; to: string }> = async sid => {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    return client.messages(sid).fetch();
  },
): Promise<LtpDestinationEvidence[]> {
  if (!override.trim() || !/^\d{11,15}$/.test(phone(override))) throw new Error("A valid SMS_TEST_OVERRIDE_TO is required");
  if (!messages.length) throw new Error("No sent messages to verify");
  const evidence = [];
  for (const message of messages) {
    if (message.status !== "sent" || !message.sent_at || !message.twilio_message_sid) {
      throw new Error("Sent message has incomplete provider evidence");
    }
    let stored;
    try { stored = await readStored(message.twilio_message_sid); }
    catch { throw new Error("Stored outbound destination is unavailable"); }
    if (stored.sid !== message.twilio_message_sid || !stored.to || phone(stored.to) !== phone(override)) {
      throw new Error("Every sent message must have gone to the current override number");
    }
    evidence.push({ message_id: message.id, twilio_message_sid: stored.sid, to: stored.to });
  }
  return evidence;
}

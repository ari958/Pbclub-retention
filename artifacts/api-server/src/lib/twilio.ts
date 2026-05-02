import twilio from "twilio";

export function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  }
  return twilio(accountSid, authToken);
}

export async function sendViaTwilio(to: string, body: string): Promise<string> {
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

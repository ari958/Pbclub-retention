import twilio from "twilio";
import type { Request, Response, NextFunction } from "express";

export const WEBHOOK_PATHS = new Set(["/api/messages/webhook/status", "/api/messages/webhook/inbound"]);

export function validateTwilioWebhook(req: Request, res: Response, next: NextFunction) {
  const base = process.env.PUBLIC_API_URL?.replace(/\/$/, "");
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!base || !token || (process.env.NODE_ENV === "production" && !base.startsWith("https://"))) {
    return void res.status(503).send("Webhook validation is not configured");
  }
  try {
    // Never use forwarded host headers to construct the signature URL.
    const url = `${base}${req.originalUrl}`;
    const signature = req.get("X-Twilio-Signature") ?? "";
    if (!signature || !twilio.validateRequest(token, signature, url, req.body)) {
      req.log?.warn({ twilio_sid: req.body?.MessageSid, signature_result: "rejected" }, "Twilio webhook signature rejected");
      return void res.status(403).send("Invalid Twilio signature");
    }
    req.log?.info({ twilio_sid: req.body?.MessageSid, signature_result: "accepted" }, "Twilio webhook signature accepted");
    next();
  } catch {
    res.status(403).send("Invalid Twilio signature");
  }
}

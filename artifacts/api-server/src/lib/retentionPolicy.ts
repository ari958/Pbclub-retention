import type { RequestHandler } from "express";

/** Retention-first defaults. Legacy features stay in place and can be unparked. */
export const isRetentionOnlyMode = () => process.env.RETENTION_ONLY_MODE !== "false";
export const requiresMarketingConsent = () => process.env.REQUIRE_MARKETING_CONSENT === "true";

export function parkInRetentionOnlyMode(error: string): RequestHandler {
  return (_req, res, next) => {
    if (!isRetentionOnlyMode()) {
      next();
      return;
    }
    res.status(423).json({ error });
  };
}

export interface TextEligibility {
  phone?: string | null;
  opted_out?: boolean | null;
  sms_opt_in?: boolean | null;
  consent_source?: string | null;
  sms_consented_at?: string | null;
}

export function isTextEligible(player: TextEligibility): boolean {
  if (!player.phone?.trim() || player.opted_out === true) return false;
  if (!requiresMarketingConsent()) return true;
  return player.sms_opt_in === true
    && player.consent_source === "web_form"
    && !!player.sms_consented_at;
}
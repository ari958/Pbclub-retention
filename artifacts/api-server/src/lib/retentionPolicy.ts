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

export type TextEligibilitySkipReason = "no_phone" | "opted_out" | "marketing_consent";

export function getTextEligibilitySkipReason(player: TextEligibility): TextEligibilitySkipReason | null {
  if (!player.phone?.trim()) return "no_phone";
  if (player.opted_out === true) return "opted_out";
  if (!requiresMarketingConsent()) return null;
  if (player.sms_opt_in === true && player.consent_source === "web_form" && !!player.sms_consented_at) return null;
  return "marketing_consent";
}

export function isTextEligible(player: TextEligibility): boolean {
  return getTextEligibilitySkipReason(player) === null;
}
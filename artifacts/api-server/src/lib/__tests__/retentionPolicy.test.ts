import { isTextEligible, requiresMarketingConsent } from "../retentionPolicy.js";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const originalConsentFlag = process.env.REQUIRE_MARKETING_CONSENT;
try {
  delete process.env.REQUIRE_MARKETING_CONSENT;
  assert(!requiresMarketingConsent(), "marketing consent is disabled by default");
  assert(isTextEligible({ phone: "+15551234567", sms_opt_in: false }), "default policy requires a phone, not sms_opt_in");
  assert(!isTextEligible({ phone: "  " }), "blank phone is ineligible");
  assert(!isTextEligible({ phone: "+15551234567", opted_out: true }), "explicit opt-out is always ineligible");

  process.env.REQUIRE_MARKETING_CONSENT = "true";
  assert(!isTextEligible({ phone: "+15551234567", sms_opt_in: true }), "marketing policy rejects missing affirmative consent facts");
  assert(isTextEligible({
    phone: "+15551234567",
    sms_opt_in: true,
    consent_source: "web_form",
    sms_consented_at: "2026-01-01T00:00:00Z",
  }), "marketing policy accepts the configured affirmative consent evidence");
} finally {
  if (originalConsentFlag === undefined) delete process.env.REQUIRE_MARKETING_CONSENT;
  else process.env.REQUIRE_MARKETING_CONSENT = originalConsentFlag;
}

console.log("Retention policy tests passed");
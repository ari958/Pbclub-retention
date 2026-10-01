import type { RetryContextEnvelope } from "./retentionApi";

export function combineRetryContextEnvelopes(envelopes: RetryContextEnvelope[]): RetryContextEnvelope {
  return envelopes.reduce<RetryContextEnvelope>((combined, envelope) => ({
    schema_ready: combined.schema_ready && envelope.schema_ready,
    results: [...combined.results, ...envelope.results],
    failures: [...(combined.failures ?? []), ...(envelope.failures ?? [])],
    podplay: {
      total_calls: combined.podplay.total_calls + envelope.podplay.total_calls,
      listing_calls: combined.podplay.listing_calls + envelope.podplay.listing_calls,
      signup_calls: combined.podplay.signup_calls + envelope.podplay.signup_calls,
      trigger_calls: combined.podplay.trigger_calls + envelope.podplay.trigger_calls,
      coupon_calls: combined.podplay.coupon_calls + envelope.podplay.coupon_calls,
      rate_limit_count: combined.podplay.rate_limit_count + envelope.podplay.rate_limit_count,
      retries: [...combined.podplay.retries, ...envelope.podplay.retries],
    },
  }), {
    schema_ready: true,
    results: [],
    failures: [],
    podplay: { total_calls: 0, listing_calls: 0, signup_calls: 0, trigger_calls: 0, coupon_calls: 0, rate_limit_count: 0, retries: [] },
  });
}
import test from "node:test";
import assert from "node:assert/strict";
import { combineRetryContextEnvelopes } from "./retryContextEnvelope.ts";
import type { RetryContextEnvelope } from "./retentionApi.ts";

const response = (schema_ready: boolean, status: RetryContextEnvelope["results"][number]["status"], calls: number): RetryContextEnvelope => ({
  schema_ready,
  results: [{
    candidate_id: `candidate-${calls}`,
    status,
    reason: null,
    body: null,
    context: {},
  }],
  failures: calls > 2 ? [{ candidate_id: `failed-${calls}`, error: "Concurrent update", http_status: 409 }] : [],
  podplay: {
    total_calls: calls,
    listing_calls: calls,
    signup_calls: 0,
    trigger_calls: 1,
    coupon_calls: 0,
    rate_limit_count: 0,
    retries: [{ path: "/events", attempt: 1, retry_number: 1, wait_ms: 100, status: 429 }],
  },
});

test("retry-context envelope aggregation retains final statuses and exact PodPlay telemetry", () => {
  const combined = combineRetryContextEnvelopes([
    response(true, "drafted", 2),
    response(true, "needs_context", 3),
  ]);
  assert.deepEqual(combined.results.map((result) => result.status), ["drafted", "needs_context"]);
  assert.deepEqual(combined.failures, [{ candidate_id: "failed-3", error: "Concurrent update", http_status: 409 }]);
  assert.deepEqual(combined.podplay, {
    total_calls: 5,
    listing_calls: 5,
    signup_calls: 0,
    trigger_calls: 2,
    coupon_calls: 0,
    rate_limit_count: 0,
    retries: [
      { path: "/events", attempt: 1, retry_number: 1, wait_ms: 100, status: 429 },
      { path: "/events", attempt: 1, retry_number: 1, wait_ms: 100, status: 429 },
    ],
  });
});

test("retry-context envelope aggregation reports schema readiness false if any batch is not ready", () => {
  assert.equal(combineRetryContextEnvelopes([
    response(true, "drafted", 1),
    response(false, "manual_edit", 1),
  ]).schema_ready, false);
});
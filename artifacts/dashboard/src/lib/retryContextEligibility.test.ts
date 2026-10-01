import test from "node:test";
import assert from "node:assert/strict";
import { isRetryContextEligible } from "./retryContextEligibility.ts";

test("context retry permits only the two designated needs-context reasons", () => {
  assert.equal(isRetryContextEligible("needs_context", "context_lookup_failed"), true);
  assert.equal(isRetryContextEligible("needs_context", "no_next_program"), true);
});

test("context retry does not loosen drafted regeneration or permit other statuses", () => {
  for (const status of ["drafted", "skipped", "approved", "sent", "manual_edit"]) {
    assert.equal(isRetryContextEligible(status, "context_lookup_failed"), false, status);
    assert.equal(isRetryContextEligible(status, "no_next_program"), false, status);
  }
  assert.equal(isRetryContextEligible("needs_context", "other_reason"), false);
  assert.equal(isRetryContextEligible("needs_context", "Context_lookup_failed"), false);
  assert.equal(isRetryContextEligible("needs_context", null), false);
});
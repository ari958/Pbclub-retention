import assert from "node:assert/strict";
import { test } from "node:test";
import { displaySequenceStatus, SEQUENCE_STATUS_LABELS } from "./sequenceStatus";

test("all declared sequence statuses render without an exhaustive-check failure", () => {
  for (const status of Object.keys(SEQUENCE_STATUS_LABELS)) {
    assert.doesNotThrow(() => displaySequenceStatus(status));
    assert.ok(displaySequenceStatus(status));
  }
  assert.equal(displaySequenceStatus("exited_test"), "Closed (test)");
  assert.equal(displaySequenceStatus(null), "sequence unavailable");
  assert.equal(displaySequenceStatus("future_status"), "future status");
});

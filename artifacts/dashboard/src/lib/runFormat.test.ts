import test from "node:test";
import assert from "node:assert/strict";
import { statusMeta, dayKey, fmtDuration, isHistoryUnavailable } from "./runFormat";

test("history status colors distinguish success, partial, failed and unfinished", () => {
  assert.notEqual(statusMeta("success").color, statusMeta("partial").color);
  assert.notEqual(statusMeta("partial").color, statusMeta("failed").color);
  assert.equal(statusMeta(null).label, "Running");
});
test("today uses club local date, including midnight and daylight saving", () => {
  assert.equal(dayKey("2026-10-09T02:00:00Z", "America/New_York"), "2026-10-08");
  assert.equal(dayKey("2026-11-01T05:30:00Z", "America/New_York"), "2026-11-01");
});
test("duration and uninstalled schema never imply a completed empty history", () => {
  assert.equal(fmtDuration("2026-10-08T07:00Z", "2026-10-08T07:18Z"), "18m 0s");
  assert.equal(fmtDuration("2026-10-08T07:00Z", null), "in progress");
  assert.equal(isHistoryUnavailable({ status: 503 }), true);
  assert.equal(isHistoryUnavailable({ status: 500 }), false);
});

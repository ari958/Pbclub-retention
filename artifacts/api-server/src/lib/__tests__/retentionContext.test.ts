import { isLearnToPlayName, normalizeRetentionName } from "../retentionContext.js";
import { getTextEligibilitySkipReason, isTextEligible } from "../retentionPolicy.js";
import {
  calendarDayDistance,
  DEFAULT_RETENTION_LOOKBACK_DAYS,
  isAttendanceDateNearRetentionWindow,
  isRetentionTriggerDate,
  normalizeRetentionLookbackDays,
  toEtDate,
  utcEtMidnight,
} from "../retentionDates.js";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

assert(normalizeRetentionName("  LEARN—TO_PLAY  ") === "learn to play", "normalizes Unicode dashes, underscores, case, and spacing");
assert(isLearnToPlayName("Learn to Play Clinic"), "matches the whole Learn to Play phrase");
assert(isLearnToPlayName("Clinic: Learn to Play"), "phrase may occur within a longer event name");
assert(!isLearnToPlayName("Path to Advanced Beginner"), "does not treat Path to Advanced Beginner as Learn to Play");
assert(!isLearnToPlayName("Learning to Play"), "does not match an unrelated word form");

assert(toEtDate("2026-03-08") === "2026-03-08", "preserves only exact date-only values without timezone conversion");
assert(toEtDate("2026-03-08T04:30:00.000Z") === "2026-03-07", "converts timestamps to the prior ET calendar day");
assert(toEtDate("2026-03-08T05:30:00.000Z") === "2026-03-08", "converts timestamps across the DST transition using ET");
assert(utcEtMidnight("2026-03-08").toISOString() === "2026-03-08T05:00:00.000Z", "computes UTC midnight for spring DST date");
assert(utcEtMidnight("2026-11-01").toISOString() === "2026-11-01T04:00:00.000Z", "computes UTC midnight for fall DST date");
assert(isRetentionTriggerDate("2026-03-07", "2026-03-08"), "includes yesterday as an eligible trigger");
assert(isRetentionTriggerDate("2026-03-01", "2026-03-08"), "includes the seven-day boundary");
assert(!isRetentionTriggerDate("2026-02-28", "2026-03-08"), "excludes dates older than seven days");
assert(!isRetentionTriggerDate("2026-03-08", "2026-03-08"), "excludes today");
assert(isAttendanceDateNearRetentionWindow("2026-02-28", "2026-03-08"), "preselects one conservative boundary day for date verification");
assert(DEFAULT_RETENTION_LOOKBACK_DAYS === 7, "defaults the retention lookback to seven days");
assert(isRetentionTriggerDate("2026-03-07", "2026-03-08", 1), "custom one-day lookback includes yesterday");
assert(!isRetentionTriggerDate("2026-03-06", "2026-03-08", 1), "custom one-day lookback excludes older triggers");
assert(isAttendanceDateNearRetentionWindow("2026-03-06", "2026-03-08", 1), "raw attendance gate includes one conservative day before a one-day trigger boundary");
assert(!isAttendanceDateNearRetentionWindow("2026-03-05", "2026-03-08", 1), "raw attendance gate excludes dates beyond its conservative boundary");
assert(normalizeRetentionLookbackDays(45) === 30, "caps effective lookback at 30 days");
assert(isRetentionTriggerDate("2026-02-06", "2026-03-08", 45), "clamped lookback applies the 30-day verified trigger boundary");
assert(!isRetentionTriggerDate("2026-02-05", "2026-03-08", 45), "clamped lookback excludes triggers older than 30 days");
for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  let rejected = false;
  try { normalizeRetentionLookbackDays(value); } catch { rejected = true; }
  assert(rejected, `rejects invalid lookback ${String(value)}`);
}
assert(calendarDayDistance("2026-03-07", "2026-03-08") === 1, "compares calendar dates across local midnight");

process.env.REQUIRE_MARKETING_CONSENT = "false";
assert(isTextEligible({ phone: " +15551234567 ", opted_out: false }), "allows nonblank phone when marketing consent is disabled");
assert(!isTextEligible({ phone: "   ", opted_out: false }), "rejects blank phone");
assert(!isTextEligible({ phone: "+15551234567", opted_out: true }), "rejects opted-out player");
assert(getTextEligibilitySkipReason({ phone: "   ", opted_out: false }) === "no_phone", "reports missing phone as a distinct skip reason");
assert(getTextEligibilitySkipReason({ phone: "+15551234567", opted_out: true }) === "opted_out", "reports opt-out as a distinct skip reason");
process.env.REQUIRE_MARKETING_CONSENT = "true";
assert(
  getTextEligibilitySkipReason({ phone: "+15551234567", sms_opt_in: false }) === "marketing_consent",
  "reports missing required marketing consent separately",
);
assert(
  getTextEligibilitySkipReason({
    phone: "+15551234567", sms_opt_in: true, consent_source: "web_form", sms_consented_at: "2026-03-01T12:00:00Z",
  }) === null,
  "allows a player with recorded web-form marketing consent",
);

console.log("Retention context and lookback tests passed");
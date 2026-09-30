import { isLearnToPlayName, normalizeRetentionName } from "../retentionContext.js";
import { isTextEligible } from "../retentionPolicy.js";
import {
  calendarDayDistance,
  isAttendanceDateNearRetentionWindow,
  isRetentionTriggerDate,
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
assert(calendarDayDistance("2026-03-07", "2026-03-08") === 1, "compares calendar dates across local midnight");

process.env.REQUIRE_MARKETING_CONSENT = "false";
assert(isTextEligible({ phone: " +15551234567 ", opted_out: false }), "allows nonblank phone when marketing consent is disabled");
assert(!isTextEligible({ phone: "   ", opted_out: false }), "rejects blank phone");
assert(!isTextEligible({ phone: "+15551234567", opted_out: true }), "rejects opted-out player");

console.log("Retention context classifier tests passed");
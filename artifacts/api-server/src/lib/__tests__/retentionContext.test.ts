import {
  buildRetentionContext,
  calculateRetentionOpenSpots,
  getRetentionEventWindow,
  isLearnToPlayName,
  isRetentionEventWithinWindow,
  normalizeRetentionName,
  RETENTION_UPCOMING_DAYS,
  RetentionContextError,
} from "../retentionContext.js";
import { getTextEligibilitySkipReason, isTextEligible } from "../retentionPolicy.js";
import {
  calendarDayDistance,
  addCalendarDays,
  DEFAULT_RETENTION_LOOKBACK_DAYS,
  hasNonLtpAttendanceAfterTrigger,
  isAttendanceDateNearRetentionWindow,
  isRetentionTriggerDate,
  normalizeRetentionLookbackDays,
  retentionSendDateMatchesSchedule,
  retentionDatePhrase,
  retentionWeekday,
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
assert(
  normalizeRetentionName("  ADVANCED—BEGINNER_60&60   CLINIC ") === "advanced beginner 60&60 clinic",
  "normalizes program names with the Learn to Play case, dash, and whitespace rules",
);

const fixedNow = new Date("2026-10-01T12:00:00.000Z");
const retentionWindow = getRetentionEventWindow(fixedNow);
assert(RETENTION_UPCOMING_DAYS === 14, "uses a fourteen-day upcoming program horizon");
assert(retentionWindow.start.toISOString() === fixedNow.toISOString(), "keeps the exact upcoming start bound");
assert(
  retentionWindow.end.getTime() - retentionWindow.start.getTime() === 14 * 24 * 60 * 60 * 1000,
  "builds an exact fourteen-day upcoming end bound",
);
assert(
  isRetentionEventWithinWindow("2026-10-01T12:00:00.001Z", retentionWindow),
  "keeps events strictly after the upcoming start bound",
);
assert(
  !isRetentionEventWithinWindow("2026-10-01T12:00:00.000Z", retentionWindow),
  "excludes events at the upcoming start bound",
);
assert(
  isRetentionEventWithinWindow("2026-10-15T12:00:00.000Z", retentionWindow),
  "includes events at the upcoming end bound",
);
assert(
  !isRetentionEventWithinWindow("2026-10-15T12:00:00.001Z", retentionWindow),
  "excludes events beyond the upcoming end bound returned by the API",
);
assert(
  calculateRetentionOpenSpots(4, [
    { status: "CONFIRMED" },
    { status: "INVALID" },
    { status: "PENDING" },
  ]) === 3,
  "counts CONFIRMED only for capacity while preserving INVALID/PENDING signup records",
);
assert(calculateRetentionOpenSpots(1, [{ status: "CONFIRMED" }]) === 0, "rejects a full event");
assert(calculateRetentionOpenSpots(undefined, []) === null, "rejects events without totalTeams");

assert(toEtDate("2026-03-08") === "2026-03-08", "preserves only exact date-only values without timezone conversion");
assert(toEtDate("2026-03-08T04:30:00.000Z") === "2026-03-07", "converts timestamps to the prior ET calendar day");
assert(toEtDate("2026-03-08T05:30:00.000Z") === "2026-03-08", "converts timestamps across the DST transition using ET");
assert(
  retentionSendDateMatchesSchedule("2026-10-01", "2026-10-02T03:30:00.000Z"),
  "allows approval when the scheduled UTC instant remains on the generated ET date",
);
assert(
  !retentionSendDateMatchesSchedule("2026-10-01", "2026-10-02T04:30:00.000Z"),
  "requires regeneration when the scheduled instant advances to a different ET date",
);
assert(
  !retentionSendDateMatchesSchedule(undefined, "2026-10-02T03:30:00.000Z"),
  "fails closed for candidates without a stored intended ET send date",
);
assert(utcEtMidnight("2026-03-08").toISOString() === "2026-03-08T05:00:00.000Z", "computes UTC midnight for spring DST date");
assert(utcEtMidnight("2026-11-01").toISOString() === "2026-11-01T04:00:00.000Z", "computes UTC midnight for fall DST date");
assert(isRetentionTriggerDate("2026-03-07", "2026-03-08"), "includes yesterday as an eligible trigger");
assert(isRetentionTriggerDate("2026-03-05", "2026-03-08"), "includes the three-day production boundary");
assert(!isRetentionTriggerDate("2026-03-04", "2026-03-08"), "excludes dates older than the production window");
assert(!isRetentionTriggerDate("2026-03-08", "2026-03-08"), "excludes today");
assert(isAttendanceDateNearRetentionWindow("2026-03-04", "2026-03-08"), "preselects one conservative boundary day before the production window");
assert(DEFAULT_RETENTION_LOOKBACK_DAYS === 3, "defaults the retention lookback to three days");
for (const days of [3, 7, 14, 30]) {
  assert(normalizeRetentionLookbackDays(days) === days, `accepts supported lookback ${days}`);
}
assert(isRetentionTriggerDate("2026-03-01", "2026-03-08", 7), "test lookback accepts a seven-day boundary");
assert(isRetentionTriggerDate("2026-02-22", "2026-03-08", 14), "test lookback accepts a fourteen-day boundary");
assert(isRetentionTriggerDate("2026-02-06", "2026-03-08", 30), "test lookback accepts a thirty-day boundary");
for (const value of [0, -1, 1, 1.5, 45, Number.NaN, Number.POSITIVE_INFINITY]) {
  let rejected = false;
  try { normalizeRetentionLookbackDays(value); } catch { rejected = true; }
  assert(rejected, `rejects invalid lookback ${String(value)}`);
}
assert(calendarDayDistance("2026-03-07", "2026-03-08") === 1, "compares calendar dates across local midnight");
assert(addCalendarDays("2026-12-31", 1) === "2027-01-01", "advances dates across a month/year boundary");
assert(
  !hasNonLtpAttendanceAfterTrigger([
    { attendance_date: "2026-03-08", is_ltp: false },
  ], "2026-03-08"),
  "does not mark an attendance on the verified trigger date as already returned",
);
assert(
  hasNonLtpAttendanceAfterTrigger([
    { attendance_date: "2026-03-09", is_ltp: false },
  ], "2026-03-08"),
  "marks non-LTP attendance strictly after the verified trigger date as already returned",
);
assert(
  !hasNonLtpAttendanceAfterTrigger([
    { attendance_date: "2026-03-09", is_ltp: true },
  ], "2026-03-08"),
  "does not count later Learn to Play attendance as a return",
);
assert(retentionWeekday("2026-10-02") === "Friday", "derives event weekday from its calendar date");
assert(retentionDatePhrase("2026-09-20", "2026-09-21T04:30:00.000Z") === "yesterday", "date phrase uses intended send date in ET across UTC midnight");
assert(retentionDatePhrase("2026-09-20", "2026-09-22T15:00:00.000Z") === "Sunday", "uses weekday for an LTP date within six past days");
assert(retentionDatePhrase("2026-10-02", "2026-09-28T15:00:00.000Z") === "Friday", "uses weekday phrase within six upcoming days");
assert(retentionDatePhrase("2026-09-20", "2026-09-27T16:00:00.000Z") === "on Sept 20", "uses month/day outside the relative window");
assert(retentionDatePhrase("2027-01-01", "2026-12-25T17:00:00.000Z") === "on Jan 1", "keeps month/day phrases correct across the year boundary");

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

const clubId = "club-test";
const testPlayer = { id: "player-test", name: "Test Player", external_id: "player-external" };
const testPlaybook = {
  key: "ltp_followup",
  name: "Learn to Play follow-up",
  enabled: true,
  promo_code: "LTPNEXT25",
  offer_text: "25% off",
  next_program_names: ["Beginner 60&60 Clinic"],
  message_guidance: null,
  holdout_pct: 0,
};

function makeContextArgs(eventList: any[], options: { eventStatus?: number; signupStatus?: number } = {}) {
  const clubCache = new Map([[
    clubId,
    Promise.resolve({ base: "https://club.podplay.app", apiKey: "diagnostic-test-secret", timezone: "America/New_York" }),
  ]]);
  const couponCache = new Map([[
    `${clubId}:LTPNEXT25`,
    Promise.resolve({ valid: true, warning: null, checked_at: new Date().toISOString() }),
  ]]);
  return {
    args: {
      clubId,
      player: testPlayer,
      playbook: testPlaybook,
      trigger: { event_id: "trigger-test", name: "Learn to Play Clinic", date: "2026-10-01" },
      classmatesExternalIds: ["classmate-invalid", "classmate-pending"],
      socialEventsCache: new Map<string, Promise<any[]>>(),
      socialSignupsCache: new Map<string, Promise<string[]>>(),
      clubCache,
      couponCache,
    },
    fetch: async (input: any, _init?: any) => {
      const url = String(input);
      if (url.includes("/apis/v2/events?")) {
        if (options.eventStatus && options.eventStatus >= 400) {
          return new Response("unavailable", { status: options.eventStatus });
        }
        return new Response(JSON.stringify({ items: eventList }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/signups?")) {
        if (options.signupStatus && options.signupStatus >= 400) {
          return new Response("unavailable", { status: options.signupStatus });
        }
        return new Response(JSON.stringify({
          items: [
            { status: "CONFIRMED", owner: { id: "player-external" } },
            { status: "INVALID", owner: { id: "classmate-invalid" } },
            { status: "PENDING", owner: { id: "classmate-pending" } },
            { status: "CANCELED", owner: { id: "classmate-canceled" } },
            { status: "DRAFT", owner: { id: "classmate-draft" } },
          ],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected test request: ${url}`);
    },
  };
}

async function withMockFetch<T>(fetcher: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testRetentionContextBuild(): Promise<void> {
  const now = Date.now();
  const events = [
    {
      id: "next-program",
      name: "  BEGINNER—60&60_CLINIC ",
      startTime: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(),
      status: "PUBLISHED",
      totalTeams: 4,
    },
    {
      id: "outside-window",
      name: "Beginner 60&60 Clinic",
      startTime: new Date(now + 15 * 24 * 60 * 60 * 1000).toISOString(),
      status: "PUBLISHED",
      totalTeams: 6,
    },
  ];
  const test = makeContextArgs(events);
  const seenUrls: string[] = [];
  const context = await withMockFetch(async (input, init) => {
    seenUrls.push(String(input));
    return test.fetch(input, init);
  }, () => buildRetentionContext(test.args));

  assert(context.next_program?.event_id === "next-program", "matches next program names after normalization");
  assert(context.next_program?.spots_remaining === 3, "uses totalTeams minus CONFIRMED signups for open spots");
  assert(context.already_booked, "preserves active existing booking semantics");
  assert(context.booked_event?.event_id === "next-program", "returns the verified booked event");
  assert(context.classmates_signed_up === 2, "counts classmates on INVALID/PENDING signups");
  const diagnostics = context.diagnostics as any;
  assert(diagnostics.upcoming.raw_event_count === 2, "records raw upcoming event count");
  assert(diagnostics.upcoming.in_window_event_count === 1, "client filters events beyond the fourteen-day boundary");
  assert(
    diagnostics.upcoming.matched_next_program_names[0] === "  BEGINNER—60&60_CLINIC ",
    "records matched live event names",
  );
  assert(diagnostics.upcoming.requests.length === 1, "records the exact upcoming GET request");
  const eventRequest = new URL(diagnostics.upcoming.requests[0].url);
  assert(eventRequest.searchParams.get("page") === "1", "records the PodPlay event pagination request");
  assert(
    Date.parse(eventRequest.searchParams.get("endTime")!) - Date.parse(eventRequest.searchParams.get("startTime")!) === 14 * 24 * 60 * 60 * 1000,
    "sends correct fourteen-day bounds to PodPlay",
  );
  assert(
    diagnostics.upcoming.requests.every((request: any) => !request.url.includes("diagnostic-test-secret")),
    "diagnostics never include PodPlay credentials",
  );
  assert(seenUrls.some((url) => url.includes("/signups?")), "loads signup records for booking, capacity, and classmates");

  const noMatchTest = makeContextArgs([{
    id: "unrelated-event",
    name: "Community Open Play",
    startTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    status: "PUBLISHED",
    totalTeams: 12,
  }]);
  let noProgramError: unknown;
  await withMockFetch(noMatchTest.fetch, async () => {
    try {
      await buildRetentionContext(noMatchTest.args);
    } catch (error) {
      noProgramError = error;
    }
  });
  assert(noProgramError instanceof RetentionContextError, "no next program throws a typed context error");
  const noProgramContextError = noProgramError as RetentionContextError;
  assert(noProgramContextError.reason === "no_next_program", "reports no_next_program as the typed reason");
  assert(noProgramContextError.errors.length > 0, "includes a clear error for missing next program context");
  assert(
    noProgramContextError.diagnostics.upcoming.filter_causes.matching_event_count === 0,
    "records why no next program matched",
  );

  const eventFailureTest = makeContextArgs([], { eventStatus: 503 });
  let eventLookupError: unknown;
  await withMockFetch(eventFailureTest.fetch, async () => {
    try {
      await buildRetentionContext(eventFailureTest.args);
    } catch (error) {
      eventLookupError = error;
    }
  });
  assert(eventLookupError instanceof RetentionContextError, "required upcoming lookup failure throws a typed error");
  const eventContextError = eventLookupError as RetentionContextError;
  assert(eventContextError.reason === "context_lookup_failed", "reports context_lookup_failed for live lookup errors");
  assert(eventContextError.diagnostics.upcoming.requests.length === 1, "retains failed upcoming GET details on the error");
  assert(eventContextError.diagnostics.lookups.next_program.status === "error", "records next-program lookup failures");
  assert(eventContextError.diagnostics.lookups.already_booked.status === "error", "records booking lookup failures");

  const signupFailureTest = makeContextArgs([{
    id: "signup-failure-event",
    name: "Beginner 60&60 Clinic",
    startTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    status: "PUBLISHED",
    totalTeams: 4,
  }], { signupStatus: 500 });
  let signupLookupError: unknown;
  await withMockFetch(signupFailureTest.fetch, async () => {
    try {
      await buildRetentionContext(signupFailureTest.args);
    } catch (error) {
      signupLookupError = error;
    }
  });
  assert(signupLookupError instanceof RetentionContextError, "required signup lookup failure throws a typed error");
  const signupContextError = signupLookupError as RetentionContextError;
  assert(signupContextError.reason === "context_lookup_failed", "fails closed on signup lookup errors");
  assert(signupContextError.diagnostics.lookups.classmate.errors.length > 0, "retains classmate lookup error details");
  assert(signupContextError.diagnostics.lookups.already_booked.errors.length > 0, "retains booking lookup error details");
}

void testRetentionContextBuild().then(() => {
  console.log("Retention context and lookback tests passed");
}).catch((error) => {
  process.nextTick(() => { throw error; });
});
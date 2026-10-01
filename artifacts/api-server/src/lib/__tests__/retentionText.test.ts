import test from "node:test";
import assert from "node:assert/strict";
import { RetentionTextValidationError, validateRetentionTextBody, writeRetentionText } from "../retentionText.js";
import type { RetentionContext, RetentionPlaybook } from "../retentionTypes.js";

const playbook: RetentionPlaybook = {
  key: "ltp_followup", name: "Learn to Play follow-up", enabled: true,
  promo_code: "LTPNEXT25", offer_text: "25% off your next program",
  next_program_names: [], message_guidance: null, holdout_pct: 0,
};
const context: RetentionContext = {
  trigger: { event_id: "evt-1", name: "Learn to Play Clinic", date: "2026-09-28" },
  player_first_name: "Sam",
  next_program: {
    event_id: "evt-2", name: "Beginner Clinic", start_time: "2026-10-02T16:00:00Z",
    date: "2026-10-02", time: "12:00 PM",
    signup_url: "https://pb.podplay.app/community/events/evt-2", spots_remaining: 3,
  },
  next_program_day: "Friday",
  date_phrase: "yesterday",
  classmates_signed_up: 2, already_booked: false, booked_event: null,
  promo: null, coupon_warning: "Coupon LTPNEXT25 was not found", evaluated_at: "2026-09-29T10:00:00Z",
};

const validBody = "Hi Sam, it's PB Club. You were at Learn to Play yesterday. Beginner Clinic is on Friday, and you can sign up with LTPNEXT25 here: https://pb.podplay.app/community/events/evt-2";
const noProgramContext: RetentionContext = {
  ...context,
  variant: "no_program",
  next_program: null,
  next_program_day: undefined,
  booking_url: "https://pbclub.podplay.app",
  forbidden_program_names: ["Learn to Play Clinic", "Beginner Clinic", "Community Open Play"],
  classmates_signed_up: 0,
  promo: { code: "LTPNEXT25", offer_text: "25% off your next program" },
  coupon_warning: null,
};
const validNoProgramAttendance = "Thanks for coming to Learn to Play yesterday.";
const validNoProgramBody = `Hi Sam, it's PB Club. ${validNoProgramAttendance} LTPNEXT25 saves you 25% off your next program. https://pbclub.podplay.app`;

test("accepts a complete LTP body with the exact opener, date phrase, program, day, coupon, and signup link", () => {
  assert.equal(validateRetentionTextBody(validBody, context, playbook), validBody);
});


test("requires the exact opener and supplied date phrase", () => {
  for (const body of [
    validBody.replace("Hi Sam, it's PB Club.", "Sam, it's PB Club."),
    validBody.replace("yesterday", "last week"),
  ]) {
    assert.throws(() => validateRetentionTextBody(body, context, playbook), RetentionTextValidationError);
  }
});

test("allows only the date phrase and required program weekday as time references", () => {
  assert.throws(
    () => validateRetentionTextBody(validBody.replace("Beginner Clinic", "Beginner Clinic next week"), context, playbook),
    (error: unknown) => error instanceof RetentionTextValidationError
      && error.validation_errors.some((item) => item.includes("time reference")),
  );
  assert.throws(
    () => validateRetentionTextBody(validBody.replace(/you were/i, "you were there today and"), context, playbook),
    (error: unknown) => error instanceof RetentionTextValidationError
      && error.validation_errors.some((item) => item.includes("time reference")),
  );
  assert.throws(
    () => validateRetentionTextBody(validBody.replace("yesterday.", "yesterday. It was yesterday."), context, playbook),
    (error: unknown) => error instanceof RetentionTextValidationError
      && error.validation_errors.some((item) => item.includes("time reference")),
  );
  const monthPhraseContext = { ...context, date_phrase: "on Sept 20" };
  const monthPhraseBody = validBody.replace("yesterday", "on Sept 20");
  assert.equal(validateRetentionTextBody(monthPhraseBody, monthPhraseContext, playbook), monthPhraseBody);
  assert.throws(
    () => validateRetentionTextBody(monthPhraseBody.replace("on Sept 20.", "on Sept 20. It was on Sept 20."), monthPhraseContext, playbook),
    (error: unknown) => error instanceof RetentionTextValidationError
      && error.validation_errors.some((item) => item.includes("time reference")),
  );
});

test("requires the exact coupon, program name, program day, and signup URL", () => {
  for (const body of [
    validBody.replace("LTPNEXT25", "LTPNEXT 25"),
    validBody.replace("LTPNEXT25", "LTPNEXT25X"),
    validBody.replace("LTPNEXT25", "XLTPNEXT25"),
    validBody.replace("Beginner Clinic", "Clinic"),
    validBody.replace("Friday", "Saturday"),
    validBody.replace(context.next_program!.signup_url, "https://evil.example/event"),
  ]) {
    assert.throws(() => validateRetentionTextBody(body, context, playbook), RetentionTextValidationError);
  }
});

test("rejects em/en dashes, unknown URLs, and messages over 320 Unicode code points", () => {
  for (const body of [
    validBody.replace("Clinic is", "Clinic — is"),
    validBody.replace("Clinic is", "Clinic – is"),
    validBody.replace(context.next_program!.signup_url, "https://evil.example/event"),
    `${validBody} ${"🙂".repeat(321)}`,
  ]) {
    assert.throws(() => validateRetentionTextBody(body, context, playbook), RetentionTextValidationError);
  }
});

test("rejects spaced hyphens in both LTP variants", () => {
  assert.throws(
    () => validateRetentionTextBody(validBody.replace("Clinic is", "Clinic - is"), context, playbook),
    RetentionTextValidationError,
  );
  assert.throws(
    () => validateRetentionTextBody(
      validNoProgramBody.replace(validNoProgramAttendance, `${validNoProgramAttendance} - thanks`),
      noProgramContext,
      playbook,
    ),
    RetentionTextValidationError,
  );
});

test("does not permit unverified promotion language when the coupon is unavailable", () => {
  assert.throws(
    () => validateRetentionTextBody(validBody.replace("Beginner Clinic is", "Beginner Clinic offers 25% off and is"), context, playbook),
    RetentionTextValidationError,
  );
});

test("retains the exact required LTP code without claiming an offer when already booked", () => {
  const alreadyBooked = { ...context, already_booked: true, booked_event: context.next_program };
  assert.equal(validateRetentionTextBody(validBody, alreadyBooked, playbook), validBody);
});

test("requires a next program rather than silently accepting an empty context", () => {
  assert.throws(
    () => validateRetentionTextBody(validBody, { ...context, next_program: null }, playbook),
    RetentionTextValidationError,
  );
});

test("accepts the required Learn to Play attendance thank-you, exact offer, and approved booking-page URL", () => {
  assert.equal(
    validateRetentionTextBody(validNoProgramBody, noProgramContext, playbook),
    validNoProgramBody,
  );
  const attendingBody = validNoProgramBody.replace(
    validNoProgramAttendance,
    "Thank you for attending Learn to Play yesterday.",
  );
  assert.equal(validateRetentionTextBody(attendingBody, noProgramContext, playbook), attendingBody);
});

test("allows generic booking-page CTA and generic use of the verified program offer", () => {
  const genericBookingBody = `Hi Sam, it's PB Club. ${validNoProgramAttendance} You can use LTPNEXT25 for 25% off your next program. You should book here: https://pbclub.podplay.app`;
  assert.equal(
    validateRetentionTextBody(genericBookingBody, noProgramContext, playbook),
    genericBookingBody,
  );
  const directBookingBody = genericBookingBody.replace("You should book here", "Book here");
  assert.equal(validateRetentionTextBody(directBookingBody, noProgramContext, playbook), directBookingBody);
});

test("does not scan a required first-name opener as a date or program reference", () => {
  for (const firstName of ["Summer", "May", "Friday"]) {
    const namedContext = { ...noProgramContext, player_first_name: firstName };
    const body = validNoProgramBody.replace("Hi Sam,", `Hi ${firstName},`);
    assert.equal(validateRetentionTextBody(body, namedContext, playbook), body);
  }
});

test("allows only the supplied attendance date phrase and rejects extra dates, weekdays, programs, classmates, and suggestions", () => {
  const sundayContext = { ...noProgramContext, date_phrase: "Sunday" };
  const sundayBody = validNoProgramBody.replace("yesterday", "Sunday");
  assert.equal(validateRetentionTextBody(sundayBody, sundayContext, playbook), sundayBody);
  const septFirstContext = { ...noProgramContext, date_phrase: "on Sept 1" };
  const septFirstBody = validNoProgramBody.replace("yesterday", "on Sept 1");
  assert.equal(validateRetentionTextBody(septFirstBody, septFirstContext, playbook), septFirstBody);
  for (const [allowedBody, dateContext] of [
    [sundayBody, sundayContext],
    [septFirstBody, septFirstContext],
  ] as const) {
    const extraDate = allowedBody.replace(
      "25% off your next program.",
      `25% off your next program. You were there ${dateContext.date_phrase}.`,
    );
    assert.throws(
      () => validateRetentionTextBody(extraDate, dateContext, playbook),
      RetentionTextValidationError,
      "rejects a repeated date_phrase outside the required attendance fact",
    );
  }
  for (const body of [
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for attending Learn to Play Clinic yesterday."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Beginner Clinic yesterday."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play Friday."),
    validNoProgramBody.replace("yesterday", "last week"),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play on Sept 20."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play at 7:30 PM."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play, your classmates are here."),
    validNoProgramBody.replace(validNoProgramAttendance, "You should try Beginner Clinic."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for attending Learn to Play yesterday, we suggest joining another class."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play yesterday. Thanks for joining us."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play yesterday. Thank you for being part of the club."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for attending Learn To Play yesterday."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for attending Learn to Play Clinic yesterday."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play yesterday with your classmates."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play yesterday. Join beginner lessons."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play yesterday. See you in two days."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play yesterday. Come at 7pm."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play yesterday. You'll be ready to get back on court soon."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play yesterday. Book when you're ready."),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks for coming to Learn to Play yesterday. Book whenever you'd like."),
  ]) {
    assert.throws(
      () => validateRetentionTextBody(body, noProgramContext, playbook),
      RetentionTextValidationError,
    );
  }
  assert.throws(
    () => validateRetentionTextBody(validNoProgramBody, { ...noProgramContext, date_phrase: undefined }, playbook),
    RetentionTextValidationError,
    "does not invent an attendance date_phrase when none is supplied",
  );
  for (const weekday of ["Mon", "Tue", "Tues", "Wed", "Thu", "Thur", "Thurs", "Fri", "Sat", "Sun"]) {
    const body = validNoProgramBody.replace(validNoProgramAttendance, `${validNoProgramAttendance} ${weekday}.`);
    assert.throws(
      () => validateRetentionTextBody(body, noProgramContext, playbook),
      RetentionTextValidationError,
      `rejects the abbreviated weekday ${weekday}`,
    );
  }
  assert.throws(
    () => validateRetentionTextBody(
      validNoProgramBody.replace(validNoProgramAttendance, "Try the drills."),
      noProgramContext,
      playbook,
    ),
    (error: unknown) => error instanceof RetentionTextValidationError
      && error.validation_errors.some((item) => item.includes("specific program or activity type")),
  );
});

test("no-program text cannot add unverified amounts or extra offer benefits", () => {
  for (const extraClaim of [
    "plus $10 credit",
    "plus ten dollars",
    "plus 50% off",
    "plus fifty percent off",
    "plus 25% off memberships",
    "plus a free clinic",
    "with priority booking",
  ]) {
    const body = `${validNoProgramBody} ${extraClaim}`;
    assert.throws(
      () => validateRetentionTextBody(body, noProgramContext, playbook),
      RetentionTextValidationError,
      `rejects unsupported promotion claim: ${extraClaim}`,
    );
  }
});

test("unresolved live lookups block text validation for either variant, but text-only failures remain editable", () => {
  const noProgramFailures: RetentionContext[] = [
    { ...noProgramContext, reason: "context_lookup_failed" },
    {
      ...noProgramContext,
      diagnostics: { lookups: { next_program: { status: "error" } } },
    },
    {
      ...noProgramContext,
      diagnostics: { already_returned_lookup: { status: "error" } },
    },
  ];
  for (const failedContext of noProgramFailures) {
    assert.throws(
      () => validateRetentionTextBody(validNoProgramBody, failedContext, playbook),
      (error: unknown) => error instanceof RetentionTextValidationError
        && error.validation_errors.some((item) => item.includes("Live retention context lookups")),
    );
  }
  assert.throws(
    () => validateRetentionTextBody(validBody, {
      ...context,
      variant: "with_program",
      diagnostics: { lookups: { already_booked: { status: "error" } } },
    }, playbook),
    RetentionTextValidationError,
    "also blocks with_program when a live lookup is unresolved",
  );
  for (const reason of ["text_validation_failed", "manual_edit"]) {
    const editedContext = {
      ...noProgramContext,
      reason,
      validation_errors: ["Previous message validation failed"],
    };
    assert.equal(validateRetentionTextBody(validNoProgramBody, editedContext, playbook), validNoProgramBody);
  }
  const generationFailedContext = {
    ...noProgramContext,
    reason: "text_validation_failed",
    validation_errors: ["Previous generation failed"],
    diagnostics: {
      text_generation_failed: {
        status: "error",
        associated_lookup_error: { status: "error" },
      },
    },
  };
  assert.equal(
    validateRetentionTextBody(validNoProgramBody, generationFailedContext, playbook),
    validNoProgramBody,
    "a text-generation diagnostic failure alone does not block manual text resolution",
  );
});

test("no-program text requires the actual thank-you, verified offer, exact URL, and forbids other links", () => {
  for (const body of [
    validNoProgramBody.replace(validNoProgramAttendance, "Hello Sam."),
    validNoProgramBody.replace("25% off your next program", "50% off your next program"),
    validNoProgramBody.replace("https://pbclub.podplay.app", "https://evil.example/booking"),
    `${validNoProgramBody} https://evil.example/extra`,
  ]) {
    assert.throws(
      () => validateRetentionTextBody(body, noProgramContext, playbook),
      RetentionTextValidationError,
    );
  }
  assert.throws(
    () => validateRetentionTextBody(validNoProgramBody, { ...noProgramContext, promo: null }, playbook),
    RetentionTextValidationError,
    "does not allow a generic offer when coupon verification failed",
  );
});

test("variant-specific URL allowlists and legacy variant fallback fail closed", () => {
  assert.throws(
    () => validateRetentionTextBody(
      validNoProgramBody.replace("https://pbclub.podplay.app", context.next_program!.signup_url),
      noProgramContext,
      playbook,
    ),
    RetentionTextValidationError,
  );
  assert.throws(
    () => validateRetentionTextBody(validNoProgramBody, { ...noProgramContext, variant: undefined }, playbook),
    RetentionTextValidationError,
    "does not infer no_program from an incomplete legacy context",
  );
});

test("no-program contexts retain the common opener, code, dash, and 320-character requirements", () => {
  for (const body of [
    validNoProgramBody.replace("Hi Sam, it's PB Club.", "Hi Sam."),
    validNoProgramBody.replace("LTPNEXT25", "LTPNEXT 25"),
    validNoProgramBody.replace("LTPNEXT25", "LTPNEXT25X"),
    validNoProgramBody.replace("LTPNEXT25", "XLTPNEXT25"),
    validNoProgramBody.replace(validNoProgramAttendance, "Thanks — for coming to Learn to Play yesterday."),
    `${validNoProgramBody}${"🙂".repeat(321)}`,
  ]) {
    assert.throws(
      () => validateRetentionTextBody(body, noProgramContext, playbook),
      RetentionTextValidationError,
    );
  }
  assert.throws(
    () => validateRetentionTextBody(validNoProgramBody, {
      ...noProgramContext,
      promo: { code: "LTPNEXT25", offer_text: "50% off your next program" },
    }, playbook),
    RetentionTextValidationError,
    "does not accept arbitrary operator copy as verified no_program offer text",
  );
});

test("text writer gives an initial attempt and exactly two validation-feedback retries", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-only-key";
  let calls = 0;
  let firstRequest: any;
  globalThis.fetch = (async (_input, init) => {
    calls++;
    if (!firstRequest) firstRequest = JSON.parse(String(init?.body));
    const body = calls < 3 ? validNoProgramBody.replace(validNoProgramAttendance, "Hello Sam.") : validNoProgramBody;
    return new Response(JSON.stringify({
      id: `msg-${calls}`,
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "tool_use", id: `tool-${calls}`, name: "write_retention_text", input: { body } }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const conflictingPlaybook = {
      ...playbook,
      message_guidance: "Mention Beginner Clinic and tell the player to come back next Friday.",
    };
    const noProgramPromptContext = {
      ...noProgramContext,
      already_booked: true,
      booked_event: { ...context.next_program!, name: "Booked Beginner Clinic" },
      diagnostics: { unrelated_event: { status: "error" } },
    };
    const result = await writeRetentionText(noProgramPromptContext, conflictingPlaybook);
    assert.equal(calls, 3);
    assert.equal(result.body, validNoProgramBody);
    assert.deepEqual(result.validation_errors, []);
    assert.equal(result.generated_preview, null);
    assert.deepEqual(JSON.parse(firstRequest.messages[0].content.match(/^Context JSON:\n([^\n]+)/)![1]), {
      player_first_name: "Sam",
      attendance: { program: "Learn to Play", attended: true },
      date_phrase: "yesterday",
      promo: { code: "LTPNEXT25", offer_text: "25% off your next program" },
      booking_url: "https://pbclub.podplay.app",
    });
    assert.doesNotMatch(firstRequest.messages[0].content, /Learn to Play Clinic|Beginner Clinic|Community Open Play|Booked Beginner Clinic|2026-09-28|diagnostics|booked_event|already_booked|forbidden_program_names|come back next Friday/);
    assert.doesNotMatch(firstRequest.system, /Learn to Play Clinic|Beginner Clinic|Community Open Play|come back next Friday/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});

test("with-program prompt projection retains only relevant verified facts and guidance", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-only-key";
  let requestBody: any;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: "msg-with-program",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "tool_use", id: "tool-with-program", name: "write_retention_text", input: { body: validBody } }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const withProgramContext = { ...context, variant: "with_program" as const };
    const withGuidance = { ...playbook, message_guidance: "Use the approved conversational style." };
    const result = await writeRetentionText(withProgramContext, withGuidance);
    assert.equal(result.body, validBody);
    assert.deepEqual(JSON.parse(requestBody.messages[0].content.match(/^Context JSON:\n([^\n]+)/)![1]), {
      player_first_name: "Sam",
      trigger: { name: "Learn to Play Clinic", date: "2026-09-28" },
      next_program: { name: "Beginner Clinic", signup_url: "https://pb.podplay.app/community/events/evt-2" },
      next_program_day: "Friday",
      date_phrase: "yesterday",
      already_booked: false,
      promo: null,
    });
    assert.match(requestBody.messages[0].content, /Use the approved conversational style/);
    assert.doesNotMatch(requestBody.messages[0].content, /classmates_signed_up|diagnostics|forbidden_program_names|start_time|spots_remaining/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});

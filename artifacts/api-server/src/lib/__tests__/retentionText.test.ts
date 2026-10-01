import test from "node:test";
import assert from "node:assert/strict";
import { RetentionTextValidationError, validateRetentionTextBody } from "../retentionText.js";
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
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLtpStepText,
  DEFAULT_LTP_SEQUENCE_CONFIG,
  formatLtpDate,
  formatLtpWhen,
  validateLtpSequenceConfig,
} from "../ltpPhraseBuilder.js";
import { RetentionTextValidationError, validateRetentionTextBody } from "../retentionText.js";
import type { RetentionContext, RetentionPlaybook } from "../retentionTypes.js";

const playbook: RetentionPlaybook = {
  key: "ltp_followup",
  name: "Learn to Play follow-up",
  enabled: true,
  promo_code: "LTPNEXT25",
  offer_text: "25% off your next program",
  next_program_names: ["Beginner Session"],
  message_guidance: null,
  holdout_pct: 0,
};

const withProgram: RetentionContext = {
  variant: "with_program",
  trigger: { event_id: "ltp-event-1", name: "Learn to Play", date: "2026-09-27" },
  player_first_name: "Sam",
  next_program: {
    event_id: "next-event-1",
    name: "Beginner Session",
    start_time: "2026-10-04T14:30:00.000Z",
    date: "2026-10-04",
    time: "10:30 AM",
    signup_url: "https://pb.podplay.app/community/events/next-event-1",
    spots_remaining: 3,
  },
  classmates_signed_up: 0,
  already_booked: false,
  booked_event: null,
  promo: { code: "LTPNEXT25", offer_text: "25% off your next program" },
  coupon_warning: null,
  evaluated_at: "2026-09-28T15:00:00.000Z",
};

test("formats ET calendar facts for both messages without weekday-only attendance dates", () => {
  assert.equal(formatLtpDate("2026-09-27"), "Sept 27");
  assert.equal(formatLtpWhen("2026-10-04T14:30:00.000Z"), "Sunday, Oct 4 at 10:30am");
});

test("selects deterministic slots and validates the assembled step-1 text", () => {
  const input = { candidateId: "candidate-1", seedNonce: 0, step: 1 as const, context: withProgram, config: DEFAULT_LTP_SEQUENCE_CONFIG };
  const first = buildLtpStepText(input);
  const second = buildLtpStepText(input);
  assert.equal(first.body, second.body);
  assert.deepEqual(first.context.ltp_text?.slot_indices, second.context.ltp_text?.slot_indices);
  assert.equal(validateRetentionTextBody(first.body, first.context, playbook), first.body);
  assert.match(first.body, /Learn to Play on Sept 27/);
  assert.match(first.body, /Beginner Session is on Sunday, Oct 4 at 10:30am/);
  assert.match(first.body, /LTPNEXT25/);
  assert.ok(first.body.endsWith(withProgram.next_program!.signup_url));
});

test("ordinary regeneration keeps every still-valid saved slot index after a playbook edit", () => {
  const original = buildLtpStepText({
    candidateId: "candidate-2", seedNonce: 0, step: 1, context: withProgram,
  });
  const editedConfig = structuredClone(DEFAULT_LTP_SEQUENCE_CONFIG);
  for (const group of Object.keys(editedConfig.step1) as Array<keyof typeof editedConfig.step1>) {
    editedConfig.step1[group].push(editedConfig.step1[group][0]);
  }
  const regenerated = buildLtpStepText({
    candidateId: "candidate-2",
    seedNonce: original.context.ltp_text!.seed_nonce,
    step: 1,
    context: withProgram,
    config: editedConfig,
    preferredSlotIndices: original.context.ltp_text!.slot_indices,
  });
  assert.deepEqual(regenerated.context.ltp_text?.slot_indices, original.context.ltp_text?.slot_indices);
  for (const [group, index] of Object.entries(original.context.ltp_text!.slot_indices)) {
    assert.equal(regenerated.context.ltp_text?.slot_templates[group], editedConfig.step1[group as keyof typeof editedConfig.step1][index]);
  }
});

test("step 1 no-program texts include only the verified offer and approved generic booking link", () => {
  const noProgramContext: RetentionContext = {
    ...withProgram,
    variant: "no_program",
    next_program: null,
    booking_url: "https://pbclub.podplay.app",
    forbidden_program_names: ["Learn to Play", "Beginner Session"],
  };
  const built = buildLtpStepText({
    candidateId: "candidate-no-program",
    seedNonce: 0,
    step: 1,
    context: noProgramContext,
  });
  assert.equal(validateRetentionTextBody(built.body, built.context, playbook), built.body);
  assert.match(built.body, /Learn to Play on Sept 27/);
  assert.match(built.body, /LTPNEXT25/);
  assert.ok(built.body.endsWith("https://pbclub.podplay.app"));
  assert.doesNotMatch(built.body, /Beginner Session/);
});

test("step 2 is promo-free and rejects alterations that add a discount", () => {
  const built = buildLtpStepText({
    candidateId: "candidate-step-2",
    seedNonce: 0,
    step: 2,
    context: withProgram,
  });
  assert.equal(built.context.promo, null);
  assert.doesNotMatch(built.body, /LTPNEXT25|%/);
  assert.equal(validateRetentionTextBody(built.body, built.context, playbook), built.body);
  assert.throws(
    () => validateRetentionTextBody(`${built.body} Use code LTPNEXT25 for 25% off.`, built.context, playbook),
    (error: unknown) => error instanceof RetentionTextValidationError
      && error.validation_errors.some((message) => message.toLowerCase().includes("step 2")),
  );
});

test("step-2 phrase configuration cannot smuggle in a coupon claim", () => {
  const unsafeConfig = structuredClone(DEFAULT_LTP_SEQUENCE_CONFIG);
  unsafeConfig.step2.nudge[0] = "Use code {promo} for 25% off.";
  assert.throws(() => validateLtpSequenceConfig(unsafeConfig), /Step 2/);
});
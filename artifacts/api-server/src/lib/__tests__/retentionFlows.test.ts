import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RETENTION_FLOW_KEY,
  LTP_FOLLOWUP_FLOW,
  RETENTION_FLOWS,
  assertPlaybookMatchesFlow,
  defineSequenceFlow,
  findRetentionFlow,
  findSequenceFlowByPromoCode,
  getRetentionFlow,
  getSequenceFlow,
  isLearnToPlayName,
  isSequenceFlowKey,
  requireSingleFlow,
  textRulesForPlaybook,
} from "../retentionFlows";
import { DEFAULT_LTP_SEQUENCE_CONFIG, validateLtpSequenceConfig } from "../ltpPhraseBuilder";
import { validateLtpSequenceText, validateRetentionTextBody } from "../retentionText";
import {
  LTP_TEXT_RULES,
  RETENTION_LTP_VERIFIED_OFFER_TEXT,
  RETENTION_NO_PROGRAM_BOOKING_URL,
  type RetentionContext,
  type RetentionPlaybook,
} from "../retentionTypes";

const WINBACK_CONFIG = {
  step2_gap_days: 7,
  step1: {
    opener: ["Hi {first}, it's PB Club."],
    thanks: ["Thanks for coming to Open Play Intro on {ltp_date}."],
    next_step: ["A good next step is {program} on {when}."],
    offer: ["Use code {promo} for 15% off:"],
    offer_no_program: ["Use code {promo} for 15% off your next visit:"],
  },
  step2: {
    opener: ["Hi {first}, it's PB Club."],
    nudge: ["We'd love to see you back on the court."],
    next_step: ["{program} on {when} still has spots."],
    no_program_cta: ["Here's what's coming up:"],
  },
};

const WINBACK_FLOW = defineSequenceFlow({
  key: "winback_followup",
  name: "Open Play Intro follow-up",
  shortLabel: "Intro",
  isTriggerProgram: (name) => /open play intro/i.test(name),
  rules: {
    triggerProgramLabel: "Open Play Intro",
    verifiedPromoCode: "WELCOME15",
    verifiedOfferText: "15% off your next visit",
    verifiedOfferPhrase: "15% off",
    verifiedPercent: 15,
    bookingUrl: "https://pbclub.podplay.app/book",
  },
  defaultConfig: WINBACK_CONFIG,
});

const ltpPlaybook: RetentionPlaybook = {
  key: "ltp_followup", name: "LTP", enabled: true, promo_code: "LTPNEXT25", offer_text: "25% off your next program",
  next_program_names: [], message_guidance: null, holdout_pct: 0,
};

test("Learn to Play follow-up is the default and only registered flow", () => {
  assert.equal(DEFAULT_RETENTION_FLOW_KEY, "ltp_followup");
  assert.deepEqual(RETENTION_FLOWS.map((flow) => flow.key), ["ltp_followup"]);
  assert.equal(findRetentionFlow("ltp_followup"), LTP_FOLLOWUP_FLOW);
  assert.equal(findRetentionFlow("winback"), undefined);
  assert.equal(findRetentionFlow(null), undefined);
  assert.throws(() => getRetentionFlow("winback"), /Unknown retention flow: winback/);
});

test("the LTP flow carries the locked Learn to Play decisions", () => {
  const flow = getSequenceFlow("ltp_followup");
  assert.equal(flow.triggerProgramLabel, "Learn to Play");
  assert.equal(flow.isTriggerProgram("Learn to Play Clinic"), true);
  assert.equal(flow.isTriggerProgram("Beginner 60&60 Clinic"), false);
  assert.equal(flow.isTriggerProgram, isLearnToPlayName);
  assert.equal(flow.opener("Sam"), "Hi Sam, it's PB Club.");
  assert.equal(flow.formatTriggerDate("2026-10-03"), "Oct 3");
  assert.equal(flow.bookingUrl, RETENTION_NO_PROGRAM_BOOKING_URL);
  assert.equal(flow.sequence.maxSteps, 2);
  assert.equal(flow.sequence.verifiedPromoCode, "LTPNEXT25");
  assert.equal(flow.sequence.verifiedOfferText, RETENTION_LTP_VERIFIED_OFFER_TEXT);
  assert.equal(flow.sequence.defaultConfig, DEFAULT_LTP_SEQUENCE_CONFIG);
});

test("step 1 carries the promo and step 2 never does", () => {
  const { sequence } = getSequenceFlow("ltp_followup");
  const playbook = {
    key: "ltp_followup", name: "LTP", enabled: true, promo_code: "LTPNEXT25", offer_text: "25% off your next program",
    next_program_names: [], message_guidance: null, holdout_pct: 0,
  };
  assert.equal(sequence.promoCodeForStep(playbook, 1), "LTPNEXT25");
  assert.equal(sequence.promoCodeForStep({ promo_code: null }, 1), "LTPNEXT25");
  assert.equal(sequence.promoCodeForStep(playbook, 2), null);
  assert.equal(sequence.playbookForStep(playbook, 1), playbook);
  const step2 = sequence.playbookForStep(playbook, 2);
  assert.equal(step2.promo_code, null);
  assert.equal(step2.offer_text, null);
  assert.deepEqual(sequence.readConfig({ ltp_sequence_config: undefined }), DEFAULT_LTP_SEQUENCE_CONFIG);
  assert.equal(sequence.readConfig({ ltp_sequence_config: { ...DEFAULT_LTP_SEQUENCE_CONFIG, step2_gap_days: 9 } }).step2_gap_days, 9);
});

test("sequence-flow checks and single-flow batches", () => {
  assert.equal(isSequenceFlowKey("ltp_followup"), true);
  assert.equal(isSequenceFlowKey("winback"), false);
  assert.equal(isSequenceFlowKey(undefined), false);
  assert.throws(() => getSequenceFlow("winback"), /Unknown retention flow/);
  assert.equal(requireSingleFlow(["ltp_followup", "ltp_followup"]).key, "ltp_followup");
  assert.throws(() => requireSingleFlow(["ltp_followup", "winback"]), /same retention flow/);
  assert.throws(() => requireSingleFlow([]), /same retention flow/);
});

test("a second flow is one defineSequenceFlow call: its texts build and validate under its own rules", () => {
  const { rules } = WINBACK_FLOW.sequence;
  assert.equal(WINBACK_FLOW.triggerProgramLabel, "Open Play Intro");
  assert.equal(WINBACK_FLOW.bookingUrl, "https://pbclub.podplay.app/book");
  assert.equal(WINBACK_FLOW.sequence.promoCodeForStep({ promo_code: null }, 1), "WELCOME15");
  assert.equal(WINBACK_FLOW.sequence.promoCodeForStep({ promo_code: null }, 2), null);
  assert.deepEqual(WINBACK_FLOW.sequence.readConfig({ ltp_sequence_config: undefined }), WINBACK_CONFIG);
  // The LTP phrase config is not valid for this flow: its thanks slots name the wrong program.
  assert.throws(() => validateLtpSequenceConfig(DEFAULT_LTP_SEQUENCE_CONFIG, rules), /name Open Play Intro/);
  assert.throws(() => validateLtpSequenceConfig(WINBACK_CONFIG), /name Learn to Play/);

  const context: RetentionContext = {
    trigger: { event_id: "intro-1", name: "Open Play Intro", date: "2026-10-06" },
    player_first_name: "Pat",
    next_program: null,
    classmates_signed_up: 0,
    already_booked: false,
    booked_event: null,
    promo: { code: "WELCOME15", offer_text: "15% off your next visit" },
    coupon_warning: null,
    evaluated_at: "2026-10-09T12:00:00.000Z",
    variant: "no_program",
  };
  const built = WINBACK_FLOW.sequence.buildStepText({ candidateId: "cand-1", seedNonce: 0, step: 1, context, promoCode: "WELCOME15" });
  assert.equal(built.body,
    "Hi Pat, it's PB Club. Thanks for coming to Open Play Intro on Oct 6. Use code WELCOME15 for 15% off your next visit: https://pbclub.podplay.app/book");
  assert.equal(built.context.booking_url, "https://pbclub.podplay.app/book");
  assert.deepEqual(validateLtpSequenceText(built.body, built.context, built.context.ltp_text!, rules), []);
  // Under the Learn to Play rules the same text is rejected on every flow-specific check.
  const ltpErrors = validateLtpSequenceText(built.body, built.context, built.context.ltp_text!);
  assert.ok(ltpErrors.some((error) => /must name Learn to Play/.test(error)), ltpErrors.join("; "));
  assert.ok(ltpErrors.some((error) => /LTPNEXT25/.test(error)), ltpErrors.join("; "));
  // The LTP coupon cannot be smuggled into the second flow.
  assert.throws(() => WINBACK_FLOW.sequence.buildStepText({
    candidateId: "cand-1", seedNonce: 0, step: 1, promoCode: "LTPNEXT25",
    context: { ...context, promo: { code: "LTPNEXT25", offer_text: "25% off your next program" } },
  }), /verified WELCOME15 15% off offer/);
  // Step 2 never carries the flow's own code either.
  const step2 = WINBACK_FLOW.sequence.buildStepText({ candidateId: "cand-1", seedNonce: 0, step: 2, context: built.context });
  assert.equal(step2.context.promo, null);
  assert.deepEqual(validateLtpSequenceText(step2.body, step2.context, step2.context.ltp_text!, rules), []);
  assert.ok(validateLtpSequenceText(`${step2.body.replace(" https://", " Use code WELCOME15 https://")}`,
    step2.context, step2.context.ltp_text!, rules).some((error) => /Step 2 cannot contain a promo code/.test(error)));
});

test("Learn to Play texts still build and validate exactly as before through the registry", () => {
  assert.equal(textRulesForPlaybook("ltp_followup"), LTP_TEXT_RULES);
  assert.equal(textRulesForPlaybook("anything_else"), LTP_TEXT_RULES);
  assert.equal(findSequenceFlowByPromoCode("LTPNEXT25"), LTP_FOLLOWUP_FLOW);
  assert.equal(findSequenceFlowByPromoCode("WELCOME15"), undefined);
  const context: RetentionContext = {
    trigger: { event_id: "ltp-1", name: "Learn to Play", date: "2026-10-06" },
    player_first_name: "Sam",
    next_program: null,
    classmates_signed_up: 0,
    already_booked: false,
    booked_event: null,
    promo: { code: "LTPNEXT25", offer_text: RETENTION_LTP_VERIFIED_OFFER_TEXT },
    coupon_warning: null,
    evaluated_at: "2026-10-09T12:00:00.000Z",
    variant: "no_program",
  };
  const built = LTP_FOLLOWUP_FLOW.sequence.buildStepText({ candidateId: "cand-2", seedNonce: 0, step: 1, context, promoCode: "LTPNEXT25" });
  assert.match(built.body, /^Hi Sam, it's PB Club\. .*Learn to Play on Oct 6\. .*LTPNEXT25.*25% off.* https:\/\/pbclub\.podplay\.app$/);
  assert.equal(validateRetentionTextBody(built.body, built.context, ltpPlaybook), built.body);
});

test("the database copy of the rules must agree with the code", () => {
  assert.doesNotThrow(() => assertPlaybookMatchesFlow(ltpPlaybook, LTP_FOLLOWUP_FLOW), "rows read before migration 031 are accepted");
  const seeded: RetentionPlaybook = {
    ...ltpPlaybook, flow_kind: "sequence", trigger_program_label: "Learn to Play", verified_promo_code: "LTPNEXT25",
    verified_offer_phrase: "25% off", booking_url: "https://pbclub.podplay.app",
  };
  assert.doesNotThrow(() => assertPlaybookMatchesFlow(seeded, LTP_FOLLOWUP_FLOW));
  assert.throws(() => assertPlaybookMatchesFlow({ ...seeded, verified_promo_code: "LTPNEXT30" }, LTP_FOLLOWUP_FLOW),
    /verified_promo_code is "LTPNEXT30", expected "LTPNEXT25"/);
  assert.throws(() => assertPlaybookMatchesFlow({ ...seeded, flow_kind: "single" }, LTP_FOLLOWUP_FLOW), /flow_kind is single/);
});

test("the engine, context, text, dispatch and send paths no longer hard-code the LTP playbook key", () => {
  const root = join(import.meta.dirname, "..");
  for (const file of [
    "retentionEngine.ts", "retentionContext.ts", "retentionText.ts", "retentionDispatch.ts",
    "ltpSequenceLifecycle.ts", "twilio.ts", "queuePoller.ts", "scheduler.ts",
    "../routes/retention.ts", "../routes/ltpSequence.ts", "../routes/ltpTestTools.ts", "../routes/retentionReports.ts",
  ]) {
    const source = readFileSync(join(root, file), "utf8");
    assert.equal(source.includes('"ltp_followup"'), false, `${file} still hard-codes the LTP playbook key`);
  }
  const engine = readFileSync(join(root, "retentionEngine.ts"), "utf8");
  assert.equal(engine.includes('"LTPNEXT25"'), false, "retentionEngine.ts still hard-codes the LTP coupon");
  assert.equal(engine.includes("isLearnToPlayName"), false, "retentionEngine.ts should ask the flow which program triggers it");
  for (const file of ["ltpPhraseBuilder.ts", "retentionText.ts", "retentionCoupons.ts", "ltpSequenceLifecycle.ts", "retentionContext.ts"]) {
    const source = readFileSync(join(root, file), "utf8");
    assert.equal(/LTPNEXT25|pbclub\.podplay\.app/.test(source), false, `${file} still hard-codes an LTP text rule`);
  }
});

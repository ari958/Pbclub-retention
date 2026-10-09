import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RETENTION_FLOW_KEY,
  LTP_FOLLOWUP_FLOW,
  RETENTION_FLOWS,
  findRetentionFlow,
  getRetentionFlow,
  getSequenceFlow,
  isLearnToPlayName,
  isSequenceFlowKey,
  requireSingleFlow,
} from "../retentionFlows";
import { DEFAULT_LTP_SEQUENCE_CONFIG } from "../ltpPhraseBuilder";
import { RETENTION_LTP_VERIFIED_OFFER_TEXT, RETENTION_NO_PROGRAM_BOOKING_URL } from "../retentionTypes";

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

test("the engine, context, text, dispatch and send paths no longer hard-code the LTP playbook key", () => {
  const root = join(import.meta.dirname, "..");
  for (const file of [
    "retentionEngine.ts", "retentionContext.ts", "retentionText.ts", "retentionDispatch.ts",
    "ltpSequenceLifecycle.ts", "twilio.ts", "queuePoller.ts",
  ]) {
    const source = readFileSync(join(root, file), "utf8");
    assert.equal(source.includes('"ltp_followup"'), false, `${file} still hard-codes the LTP playbook key`);
  }
  const engine = readFileSync(join(root, "retentionEngine.ts"), "utf8");
  assert.equal(engine.includes('"LTPNEXT25"'), false, "retentionEngine.ts still hard-codes the LTP coupon");
  assert.equal(engine.includes("isLearnToPlayName"), false, "retentionEngine.ts should ask the flow which program triggers it");
});

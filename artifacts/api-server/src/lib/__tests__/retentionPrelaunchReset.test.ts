import assert from "node:assert/strict";
import test from "node:test";
import { canReplacePrelaunchCandidate } from "../retentionPrelaunchReset";

const reset = () => ({
  status: "skipped", step: 1, trigger_event_id: "ltp",
  context: { reason: "pre_launch_reset" },
  messages: {
    status: "archived", error_message: "pre_launch_reset", direction: "outbound",
    simulated: false, approved_at: null, approved_by: null, approved_body: null,
    scheduled_send_at: null, sent_at: null, dispatch_claimed_at: null,
    dispatch_token: null, twilio_message_sid: null, delivery_status: null,
    delivered_at: null, retention_delivery_kind: null,
  },
  retention_sequences: {
    sequence_status: "active", trigger_event_id: "ltp", step1_sent_at: null,
    step1_message_id: null, step1_delivery_kind: null, step2_sent_at: null,
    step2_message_id: null, exited_at: null, exit_reason: null,
  },
});

test("only an archived never-approved never-sent reset for the same trigger can be replaced", () => {
  assert.equal(canReplacePrelaunchCandidate(reset(), "ltp"), true);
  assert.equal(canReplacePrelaunchCandidate(reset(), "different-trigger"), false);
  for (const status of ["drafted", "approved", "sent", "needs_context"]) {
    assert.equal(canReplacePrelaunchCandidate({ ...reset(), status }, "ltp"), false);
  }
  assert.equal(canReplacePrelaunchCandidate({ ...reset(), context: { reason: "operator_skip" } }, "ltp"), false);
  assert.equal(canReplacePrelaunchCandidate({ ...reset(), step: 2 }, "ltp"), false);
  assert.equal(canReplacePrelaunchCandidate({ ...reset(), messages: null }, "ltp"), false);
  assert.equal(canReplacePrelaunchCandidate({ ...reset(), retention_sequences: null }, "ltp"), false);
});

test("every approval, dispatch and delivery field fails closed, including missing fields", () => {
  for (const field of Object.keys(reset().messages)) {
    const value = reset().messages[field as keyof ReturnType<typeof reset>["messages"]];
    const message = { ...reset().messages, [field]: value === null ? "evidence" : value === false ? true : "other" };
    assert.equal(canReplacePrelaunchCandidate({ ...reset(), messages: message }, "ltp"), false, field);
    assert.equal(canReplacePrelaunchCandidate({ ...reset(), messages: { ...reset().messages, [field]: undefined } }, "ltp"), false, `missing ${field}`);
  }
  for (const field of Object.keys(reset().retention_sequences)) {
    assert.equal(canReplacePrelaunchCandidate({
      ...reset(), retention_sequences: { ...reset().retention_sequences, [field]: "other" },
    }, "ltp"), false, field);
  }
});

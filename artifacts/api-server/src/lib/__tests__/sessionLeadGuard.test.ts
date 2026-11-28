import test from "node:test";
import assert from "node:assert/strict";
import { assertNamedSessionAfterSend } from "../retentionCandidateApproval";

test("approval refuses a text whose named session starts before or within an hour of sending", () => {
  const twoPm = new Date("2026-11-28T19:00:00Z");
  const at = (iso: string) => ({ next_program: { start_time: iso, name: "Clinic" } });
  assert.throws(() => assertNamedSessionAfterSend(at("2026-11-28T16:00:00Z"), twoPm), /starts too soon/);
  assert.throws(() => assertNamedSessionAfterSend(at("2026-11-28T19:30:00Z"), twoPm), /starts too soon/);
  assert.doesNotThrow(() => assertNamedSessionAfterSend(at("2026-11-28T20:00:00Z"), twoPm));
  assert.doesNotThrow(() => assertNamedSessionAfterSend({ next_program: null }, twoPm));
  assert.doesNotThrow(() => assertNamedSessionAfterSend({}, twoPm));
});

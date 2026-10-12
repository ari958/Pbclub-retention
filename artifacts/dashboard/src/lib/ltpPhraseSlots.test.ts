import assert from "node:assert/strict";
import test from "node:test";
import {
  canApproveLtpCandidate,
  canReshuffleLtpCandidate,
  formatLtpAttendanceDate,
  formatLtpNextProgramFact,
  formatLtpSessionWhen,
  formatLtpTriggerFact,
  isSequenceCandidate,
  LTP_PHRASE_SLOT_KEYS,
  ltpPhraseSlot,
  parsePhraseSlotEditor,
  updateLtpPhraseSlot,
  validateLtpSequenceConfig,
} from "./ltpPhraseSlots";

test("session-change timestamps use America/New_York regardless of browser timezone", () => {
  assert.equal(formatLtpSessionWhen("2026-10-04T18:00:00.000Z"), "Sunday, Oct 4 at 2:00pm");
  assert.equal(formatLtpSessionWhen("2026-10-04T14:30:00.000Z"), "Sunday, Oct 4 at 10:30am");
  assert.equal(formatLtpSessionWhen("not-a-time"), null);
});

/** Stands in for the server's default phrase config, which the approvals response now carries. */
const DEFAULT_LTP_SEQUENCE_CONFIG = {
  step2_gap_days: 7,
  step1: {
    opener: ["Hi {first}, it's PB Club."],
    thanks: ["Thanks for coming to Learn to Play on {ltp_date}."],
    next_step: ["A good next step is {program} on {when}."],
    offer: ["Use code {promo} for 25% off:"],
    offer_no_program: ["Use code {promo} for 25% off your next program:"],
  },
  step2: {
    opener: ["Hi {first}, it's PB Club."],
    nudge: ["We'd love to see you back on the court."],
    next_step: ["{program} on {when} still has spots."],
    no_program_cta: ["Here's what's coming up:"],
  },
};

function candidate(fields: Record<string, unknown> = {}) {
  return {
    playbook_key: "ltp_followup",
    status: "drafted",
    step: 1,
    sequence_status: "active",
    context: { ltp_text: { step: 1 } },
    ...fields,
  } as any;
}

test("every configured step slot defaults to independently editable nonempty phrase alternatives", () => {
  assert.equal(validateLtpSequenceConfig(DEFAULT_LTP_SEQUENCE_CONFIG), true);
  assert.deepEqual(LTP_PHRASE_SLOT_KEYS, [
    "step1.opener", "step1.thanks", "step1.next_step", "step1.offer", "step1.offer_no_program",
    "step2.opener", "step2.nudge", "step2.next_step", "step2.no_program_cta",
  ]);
  for (const key of LTP_PHRASE_SLOT_KEYS) assert.ok(ltpPhraseSlot(DEFAULT_LTP_SEQUENCE_CONFIG, key).length > 0);
});

test("gap range and every separate phrase slot are validated without silently dropping input", () => {
  assert.equal(validateLtpSequenceConfig({ ...DEFAULT_LTP_SEQUENCE_CONFIG, step2_gap_days: 6 }), false);
  assert.equal(validateLtpSequenceConfig({ ...DEFAULT_LTP_SEQUENCE_CONFIG, step2_gap_days: 31 }), false);
  const invalidStep2 = { ...DEFAULT_LTP_SEQUENCE_CONFIG, step2: { ...DEFAULT_LTP_SEQUENCE_CONFIG.step2, nudge: [""] } };
  assert.equal(validateLtpSequenceConfig(invalidStep2), false);
  assert.deepEqual(parsePhraseSlotEditor("one\n\n two \nthree"), ["one", "two", "three"]);
  const updated = updateLtpPhraseSlot(DEFAULT_LTP_SEQUENCE_CONFIG, "step2.nudge", ["Edited wording"]);
  assert.deepEqual(ltpPhraseSlot(updated, "step2.nudge"), ["Edited wording"]);
  assert.deepEqual(ltpPhraseSlot(updated, "step1.thanks"), DEFAULT_LTP_SEQUENCE_CONFIG.step1.thanks);
});

test("LTP fact cards use code-filled attendance date and ET session time exactly as the text builder does", () => {
  const card = candidate({
    context: {
      trigger: { name: "Learn to Play", date: "2025-09-27" },
      ltp_text: {
        step: 1, seed_nonce: 0, slot_indices: {}, slot_templates: {},
        opener: "Hi Alex, it's PB Club.", ltp_date: "Sept 27", when: "Saturday, Oct 4 at 10:30am",
      },
      next_program: {
        event_id: "event-1", name: "Beginner Clinic", start_time: "2025-10-04T14:30:00Z",
        date: "Sunday, Oct 4", time: "10:30 AM", signup_url: "https://example.test/signup", spots_remaining: 2,
      },
    },
  });
  assert.equal(formatLtpTriggerFact(card), "Learn to Play on Sept 27");
  assert.equal(formatLtpNextProgramFact(card), "Beginner Clinic, Saturday, Oct 4 at 10:30am");
  const legacyCard = candidate({
    context: {
      trigger: { name: "Learn to Play", date: "2025-09-27" },
      next_program: {
        event_id: "event-1", name: "Beginner Clinic", start_time: "2025-10-04T14:30:00Z",
        date: "Saturday", time: "legacy weekday format", signup_url: "https://example.test/signup", spots_remaining: 2,
      },
    },
  });
  assert.equal(formatLtpAttendanceDate(legacyCard), "Sept 27");
  assert.equal(formatLtpTriggerFact(legacyCard), "Learn to Play on Sept 27");
  assert.equal(formatLtpNextProgramFact(legacyCard), "Beginner Clinic, Saturday, Oct 4 at 10:30am");
});

test("migration or marker missing keeps legacy LTP drafts from approval and reshuffling", () => {
  assert.equal(canApproveLtpCandidate(candidate({ context: {} }), true), false);
  assert.equal(canApproveLtpCandidate(candidate({ context: { ltp_text: { step: 1 } } }), false), false);
  assert.equal(canApproveLtpCandidate(candidate({ status: "approved" }), true), false);
  assert.equal(canReshuffleLtpCandidate(candidate({ context: {} }), true), false);
  assert.equal(canReshuffleLtpCandidate(candidate({ step: 2, context: { ltp_text: { step: 2 } } }), true), true);
  assert.equal(canApproveLtpCandidate(candidate({ context: { ltp_text: { step: 1 }, reason: "session_changed" } }), true), false);
  assert.equal(canReshuffleLtpCandidate(candidate({ context: { ltp_text: { step: 1 }, reason: "session_changed" } }), true), false);
  assert.equal(canApproveLtpCandidate(candidate({ step: 2, context: { ltp_text: { step: 1 } } }), true), false);
});

test("sequence-ness comes from the playbook row, falling back to the Learn to Play key", () => {
  assert.equal(isSequenceCandidate(candidate(), undefined), true);
  assert.equal(isSequenceCandidate({ playbook_key: "other" }, undefined), false);
  assert.equal(isSequenceCandidate({ playbook_key: "other" }, { flow_kind: "sequence" }), true);
  assert.equal(isSequenceCandidate(candidate(), { flow_kind: "single" }), false);
  // A second sequence flow gets the same approval gate as Learn to Play.
  assert.equal(canApproveLtpCandidate({ ...candidate(), playbook_key: "winback_followup", context: {} } as any, true, { flow_kind: "sequence" }), false);
  assert.equal(canApproveLtpCandidate({ ...candidate(), playbook_key: "winback_followup" } as any, true, { flow_kind: "sequence" }), true);
  assert.equal(canReshuffleLtpCandidate({ ...candidate(), playbook_key: "winback_followup" } as any, true, { flow_kind: "sequence" }), true);
  assert.equal(formatLtpTriggerFact(candidate({ playbook_key: "winback_followup", context: { trigger: { name: "Open Play Intro", date: "2026-10-06" } } }), { flow_kind: "sequence" }), "Open Play Intro on Oct 6");
});

test("LTP reshuffle permits either matching step on active drafted LTP rows only", () => {
  assert.equal(canApproveLtpCandidate({ ...candidate(), playbook_key: "other" } as any, false), true);
  assert.equal(canReshuffleLtpCandidate(candidate(), true), true);
  assert.equal(canReshuffleLtpCandidate(candidate({ step: 2, context: { ltp_text: { step: 2 } } }), true), true);
  assert.equal(canReshuffleLtpCandidate(candidate({ step: 2, context: { ltp_text: { step: 1 } } }), true), false);
  assert.equal(canReshuffleLtpCandidate(candidate({ sequence_status: "paused_reply" }), true), false);
  assert.equal(canReshuffleLtpCandidate(candidate({ status: "manual_edit" }), true), false);
});
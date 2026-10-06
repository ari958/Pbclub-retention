import assert from "node:assert/strict";
import { test } from "node:test";
import { supabase } from "../supabaseClient";
import { ltpTestRpc, readLtpTestControl, requireLtpTestOverride, normalizeCreatedLtpTestDrafts, resetSimulatedLtpTestMessage, prepareLtpSimulationResetRetry } from "../ltpTestTools";
import { stepOneRealSentAt, recheckLtpSequenceDispatch } from "../ltpSequenceLifecycle";
import { buildLtpStepText } from "../ltpPhraseBuilder";
import { validateLtpSequenceText } from "../retentionText";
import type { RetentionCandidate, RetentionContext } from "../retentionTypes";
import { generateDueLtpStep2Drafts } from "../retentionEngine";

const originalFrom = supabase.from;
const originalRpc = supabase.rpc;
const override = process.env.SMS_TEST_OVERRIDE_TO;
const sentAt = "2026-10-06T12:00:00Z";
const candidate = { club_id: "club", sequence_id: "sequence", step: 2,
  sequence_status: "active", context: { ltp_text: { step: 2 } } } as RetentionCandidate;

function mockRows(kind: "test" | "real" = "test", booking = false) {
  const rows: Record<string, unknown> = {
    retention_sequences: { sequence_status: "active", step1_sent_at: sentAt, step1_delivery_kind: kind },
    retention_ltp_test_controls: { original_sent_at: sentAt, effective_sent_at: "2026-09-29T12:00:00Z", simulated_booking: booking },
    retention_candidates: { message_id: "message" },
    messages: { status: "sent", sent_at: sentAt, simulated: false, retention_delivery_kind: kind },
    contact_ledger: { is_test: kind === "test" },
  };
  supabase.from = ((table: string) => {
    const q: any = {
      select: () => q, eq: () => q, limit: () => q,
      maybeSingle: async () => ({ data: rows[table], error: null }),
    };
    return q;
  }) as typeof supabase.from;
}
function restore() {
  supabase.from = originalFrom; supabase.rpc = originalRpc;
  if (override === undefined) delete process.env.SMS_TEST_OVERRIDE_TO;
  else process.env.SMS_TEST_OVERRIDE_TO = override;
}

test("simulation recovery keeps needs_context, preserves the cause, and fails closed on races", async () => {
  const reset = { id: "reset", status: "needs_context", updated_at: sentAt,
    context: { reason: "test_reset_requires_rebuild", errors: ["Fresh facts required"] } };
  let loseRace = false;
  let updates = 0;
  let guards: Array<[string, unknown]> = [];
  try {
    process.env.SMS_TEST_OVERRIDE_TO = "configured-test-fixture";
    supabase.from = ((table: string) => {
      assert.equal(table, "retention_candidates");
      const q: any = { select: () => q,
        eq: (key: string, value: unknown) => { guards.push([key, value]); return q; },
        update: (value: any) => {
          updates++;
          assert.deepEqual(value, { context: { ...reset.context,
            reason: "context_lookup_failed", recovery_reason: "test_reset_requires_rebuild" } });
          return q;
        },
        maybeSingle: async () => ({ data: loseRace ? null : { id: reset.id }, error: null }) };
      return q;
    }) as any;
    await prepareLtpSimulationResetRetry("club", reset);
    assert.ok(guards.some(([key,value]) => key === "status" && value === "needs_context"));
    assert.ok(guards.some(([key,value]) => key === "updated_at" && value === sentAt));
    assert.ok(guards.some(([key,value]) => key === "context" && value === JSON.stringify(reset.context)));
    await assert.rejects(prepareLtpSimulationResetRetry("club", { ...reset, status: "approved" }), /Only a reset/);
    assert.equal(updates, 1);
    loseRace = true;
    await assert.rejects(prepareLtpSimulationResetRetry("club", reset), /changed before context recovery/);
    delete process.env.SMS_TEST_OVERRIDE_TO;
    await assert.rejects(prepareLtpSimulationResetRetry("club", reset), (e: any) => e.status === 403);
  } finally { restore(); }
});

test("all test actions refuse with 403 before database access when override is absent", async () => {
  try {
    delete process.env.SMS_TEST_OVERRIDE_TO;
    supabase.rpc = (() => { throw new Error("Unexpected database call"); }) as any;
    assert.throws(requireLtpTestOverride, (e: any) => e.status === 403);
    await assert.rejects(ltpTestRpc("backdate", "club", {}), (e: any) => e.status === 403);
    await assert.rejects(resetSimulatedLtpTestMessage("club", "candidate", "Fixture operator"), (e: any) => e.status === 403);
    assert.equal(await readLtpTestControl("club", "sequence"), null);
  } finally { restore(); }
});

test("backdated test eligibility uses original send time for booking checks; real mode rejects test sends", async () => {
  try {
    mockRows();
    delete process.env.SMS_TEST_OVERRIDE_TO;
    await assert.rejects(stepOneRealSentAt(candidate), /confirmed real/);
    process.env.SMS_TEST_OVERRIDE_TO = "configured-test-fixture";
    assert.equal(await stepOneRealSentAt(candidate), sentAt);
    mockRows("real");
    delete process.env.SMS_TEST_OVERRIDE_TO;
    assert.equal(await stepOneRealSentAt(candidate), sentAt);
  } finally { restore(); }
});

test("dispatch finds simulated booking before live session requests or transport", async () => {
  try {
    mockRows("test", true);
    process.env.SMS_TEST_OVERRIDE_TO = "configured-test-fixture";
    const check = await recheckLtpSequenceDispatch(candidate, {}, "Hi Test, PB Club here.");
    assert.equal(check.valid, false);
    assert.equal(check.booked?.source, "test_simulated_booking");
    assert.equal(check.cutoff, sentAt);
  } finally { restore(); }
});

test("step 2 no-program copy has no promotion; code and percentage edits are rejected", () => {
  const context = { trigger: { date: "2026-09-20" }, player_first_name: "Test",
    variant: "no_program", next_program: null } as RetentionContext;
  const built = buildLtpStepText({ candidateId: "fixture", seedNonce: 0, step: 2, context });
  assert.deepEqual(validateLtpSequenceText(built.body, built.context, built.context.ltp_text!), []);
  for (const promotion of ["Use code LTPNEXT25.", "25% off.", "25 percent off."]) {
    assert.ok(validateLtpSequenceText(`${promotion} ${built.body}`, built.context, built.context.ltp_text!).length > 0);
  }
});

test("legacy creation-time defaults are cleared only on verified unapproved test drafts", async () => {
  const row = { id: "draft", message_id: "pending-message", player_id: "player", club_id: "club",
    sequence_id: "sequence", step: 2, status: "drafted", created_at: sentAt, context: { ltp_test_mode: true } };
  let updates = 0;
  let delivered = false;
  let guards: Array<[string, unknown]> = [];
  try {
    process.env.SMS_TEST_OVERRIDE_TO = "configured-test-fixture";
    supabase.rpc = (async (name: string, args: any) => {
      assert.equal(name, "retention_ltp_test_rpc"); assert.equal(args.p_operation, "due");
      return { data: [], error: null };
    }) as any;
    supabase.from = ((table: string) => {
      let updating = false;
      const q: any = { select: () => q, eq: (key: string, value: unknown) => { guards.push([key,value]); return q; },
        in: () => q, is: (key: string, value: unknown) => { guards.push([key,value]); return q; },
        update: (values: unknown) => { updating = true; updates++; assert.deepEqual(values, { sent_at: null }); return q; },
        maybeSingle: async () => ({ data: updating ? { id: "pending-message" } : {
          id: "pending-message", status: delivered ? "sent" : "pending", sent_at: sentAt,
          approved_at: null, scheduled_send_at: null, dispatch_claimed_at: null,
          retention_delivery_kind: null, delivery_status: null, delivered_at: null,
        }, error: null }),
        then: (resolve: any, reject: any) => Promise.resolve({ data: [{ candidate_id: "source" }], error: null }).then(resolve,reject) };
      return q;
    }) as any;
    await normalizeCreatedLtpTestDrafts("club", [row]);
    assert.equal(updates, 1);
    assert.ok(guards.some(([key,value]) => key === "status" && value === "pending"));
    for (const key of ["approved_at","scheduled_send_at","dispatch_claimed_at","retention_delivery_kind","delivery_status","delivered_at"]) {
      assert.ok(guards.some(([field,value]) => field === key && value === null));
    }
    delivered = true;
    await assert.rejects(normalizeCreatedLtpTestDrafts("club", [row]), /evidence/);
    await assert.rejects(normalizeCreatedLtpTestDrafts("club", [{ ...row, context: {} }]), /Only newly/);
    assert.equal(updates, 1);
  } finally { restore(); }
});

test("attendance found during test drafting exits the sequence without saving any step-2 draft", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ name: string; args: any }> = [];
  const club = "00000000-0000-4000-8000-000000000001";
  const source = "00000000-0000-4000-8000-000000000002";
  try {
    process.env.SMS_TEST_OVERRIDE_TO = "configured-test-fixture";
    supabase.rpc = (async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === "retention_sequence_ready") return { data: true, error: null };
      if (name === "retention_ltp_test_rpc" && args.p_operation === "due") return { data: [{
        id: source, player_id: "fixture-player", trigger_event_id: "trigger", sequence_id: "fixture-sequence",
        step: 1, step1_sent_at: sentAt, step1_delivery_kind: "test", test_mode: true,
        context: { trigger: { date: "2026-09-20" }, player_first_name: "Test" },
      }], error: null };
      if (name === "retention_sequence_transition") return { data: { sequence_status: "exited_booked" }, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    }) as any;
    supabase.from = ((table: string) => {
      const response = () => {
        if (table === "retention_playbooks") return { data: { key: "ltp_followup", enabled: true }, error: null };
        if (table === "players") return { data: { id: "fixture-player", name: "Test Player", club_id: club, opted_out: false }, error: null };
        if (table === "clubs") return { data: { platform_subdomain: "fixture", platform_api_key: "synthetic-fixture" }, error: null };
        if (table === "attendances") return { data: [{
          event_id: "later-booking", program_name: "Beginner", attended_at: "2026-10-06T12:01:00Z",
        }], error: null };
        throw new Error(`Unexpected table ${table}`);
      };
      const query: any = { select: () => query, eq: () => query, in: () => query, order: () => query,
        maybeSingle: async () => response(), then: (resolve: any, reject: any) => Promise.resolve(response()).then(resolve, reject) };
      return query;
    }) as any;
    globalThis.fetch = async () => new Response(JSON.stringify({
      id: "trigger", name: "Learn to Play Clinic", startTime: "2026-09-20T14:00:00Z",
    }));
    const result = await generateDueLtpStep2Drafts(club, [source]);
    assert.deepEqual(result.failures, []);
    assert.equal(result.results[0]?.reason, "already_returned");
    assert.equal(result.results[0]?.body, null);
    assert.ok(calls.some((call) => call.name === "retention_sequence_transition" && call.args.p_status === "exited_booked"));
    assert.ok(!calls.some((call) => call.name === "retention_sequence_save_batch" || call.args?.p_operation === "save"));
  } finally { globalThis.fetch = originalFetch; restore(); }
});

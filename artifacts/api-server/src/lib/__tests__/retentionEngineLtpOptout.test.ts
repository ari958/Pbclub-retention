import assert from "node:assert/strict";
import test from "node:test";
import { generateDueLtpStep2Drafts, regenerateLtpCandidateBatch } from "../retentionEngine.js";
import { supabase } from "../supabaseClient.js";
import { flushRunHistoryForTests } from "../runHistory";

const CLUB_ID = "00000000-0000-4000-8000-000000000031";
const PLAYER_ID = "00000000-0000-4000-8000-000000000032";
const CANDIDATE_ID = "00000000-0000-4000-8000-000000000033";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000034";
const SEQUENCE_ID = "00000000-0000-4000-8000-000000000035";
const TRIGGER_ID = "00000000-0000-4000-8000-000000000036";

const dueStep2Row = {
  player_id: PLAYER_ID,
  trigger_event_id: TRIGGER_ID,
  sequence_id: SEQUENCE_ID,
  step: "1",
  step1_delivery_kind: "real",
  step1_sent_at: "2026-09-01T13:00:00.000Z",
  context: {
    trigger: { event_id: TRIGGER_ID, name: "Learn to Play", date: "2026-09-01" },
    player_first_name: "Sam",
    next_program: null,
    classmates_signed_up: 0,
    already_booked: false,
    booked_event: null,
    promo: null,
    coupon_warning: null,
    evaluated_at: "2026-09-01T13:00:00.000Z",
  },
};

function mockSupabase(options: { dueRows?: unknown[]; candidate?: unknown }) {
  const originalFrom = (supabase as any).from;
  const originalRpc = (supabase as any).rpc;
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const tableCalls: string[] = [];
  const history = new Map<string, any>();
  (supabase as any).from = (table: string) => {
    tableCalls.push(table);
    if (table === "retention_generation_runs") return {
      upsert(row: any) { return { abortSignal: async () => {
        history.set(row.id, structuredClone(row));
        return { error: null };
      } }; },
    };
    const query: any = {
      select() { return query; },
      eq() { return query; },
      in() { return query; },
      maybeSingle() {
        if (table === "players") {
          return Promise.resolve({
            data: { id: PLAYER_ID, club_id: CLUB_ID, name: "Fixture opted-out player", opted_out: true },
            error: null,
          });
        }
        if (table === "retention_playbooks") {
          return Promise.resolve({
            data: { key: "ltp_followup", enabled: true, promo_code: "LTPNEXT25" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: { message: `unexpected maybeSingle for ${table}` } });
      },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        const data = table === "retention_candidates" && options.candidate
          ? [options.candidate]
          : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return query;
  };
  (supabase as any).rpc = async (name: string, args: any) => {
    rpcCalls.push({ name, args });
    if (name === "retention_sequence_ready") return { data: true, error: null };
    if (name === "retention_sequence_due_step2") return { data: options.dueRows ?? [], error: null };
    if (name === "retention_sequence_transition") return { data: { sequence_status: args.p_status }, error: null };
    return { data: null, error: { message: `unexpected RPC ${name}` } };
  };
  return {
    rpcCalls,
    tableCalls,
    history,
    restore() {
      (supabase as any).from = originalFrom;
      (supabase as any).rpc = originalRpc;
    },
  };
}

test("due step 2 opt-out exits before building or saving a candidate", async () => {
  const mocked = mockSupabase({ dueRows: [dueStep2Row] });
  try {
    const result = await generateDueLtpStep2Drafts(CLUB_ID);
    await flushRunHistoryForTests();
    assert.deepEqual(result.failures, []);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, "skipped");
    assert.equal(result.results[0].reason, "opted_out");
    assert.ok(mocked.rpcCalls.some(({ name, args }) =>
      name === "retention_sequence_transition"
      && args.p_status === "exited_opt_out"
      && args.p_reason === "player_opted_out"));
    assert.ok(!mocked.rpcCalls.some(({ name }) => name === "retention_sequence_save_batch"));
    assert.deepEqual(mocked.tableCalls.filter(table => table !== "retention_generation_runs"), ["retention_playbooks", "players"]);
    assert.equal(mocked.history.size, 1);
    const run = [...mocked.history.values()][0];
    assert.equal(run.status, "success"); assert.equal(run.skipped, 1); assert.equal(run.errors, 0);
    assert.equal(run.details.outcomes[0].player_name, "Fixture opted-out player");
  } finally {
    mocked.restore();
  }
});

test("manual LTP regeneration transitions an opted-out player and returns HTTP 409 without changing the draft", async () => {
  const mocked = mockSupabase({
    candidate: {
      id: CANDIDATE_ID,
      club_id: CLUB_ID,
      player_id: PLAYER_ID,
      playbook_key: "ltp_followup",
      trigger_event_id: TRIGGER_ID,
      context: { trigger: { event_id: TRIGGER_ID, name: "Learn to Play", date: "2026-09-01" } },
      status: "drafted",
      message_id: MESSAGE_ID,
      step: 1,
      sequence_id: SEQUENCE_ID,
      updated_at: "2026-09-01T13:00:00.000Z",
    },
  });
  try {
    await assert.rejects(
      regenerateLtpCandidateBatch(CLUB_ID, [CANDIDATE_ID]),
      (error: unknown) => (error as { status?: number }).status === 409,
    );
    await flushRunHistoryForTests();
    assert.ok(mocked.rpcCalls.some(({ name, args }) =>
      name === "retention_sequence_transition"
      && args.p_status === "exited_opt_out"
      && args.p_reason === "player_opted_out"));
    assert.ok(!mocked.rpcCalls.some(({ name }) => name === "retention_sequence_save_batch"));
    assert.deepEqual(mocked.tableCalls.filter(table => table !== "retention_generation_runs"), ["retention_candidates", "retention_playbooks", "players"]);
    assert.equal(mocked.history.size, 1);
    assert.equal([...mocked.history.values()][0].status, "failed");
  } finally {
    mocked.restore();
  }
});
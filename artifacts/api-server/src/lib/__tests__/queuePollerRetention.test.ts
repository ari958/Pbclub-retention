import assert from "node:assert/strict";
import { test } from "node:test";
import { supabase } from "../supabaseClient.js";
import { runQueueTick } from "../queuePoller.js";

const originalRetentionMode = process.env.RETENTION_ONLY_MODE;
const originalSmsLive = process.env.SMS_LIVE;
const originalSupabaseFrom = (supabase as any).from;

const MESSAGE_ID = "00000000-0000-4000-8000-000000000011";
const PLAYER_ID = "00000000-0000-4000-8000-000000000012";
const CLUB_ID = "00000000-0000-4000-8000-000000000013";

const state: {
  candidate: any;
  candidateError: { message: string } | null;
  updates: Array<{ table: string; values: any }>;
  reads: string[];
} = {
  candidate: null,
  candidateError: null,
  updates: [],
  reads: [],
};

function queryFor(table: string) {
  let operation = "select";
  let values: any;
  const query: any = {
    select() { return query; },
    update(next: any) {
      operation = "update";
      values = next;
      state.updates.push({ table, values: next });
      return query;
    },
    eq() { return query; },
    is() { return query; },
    neq() { return query; },
    not() { return query; },
    lte() { return query; },
    order() { return query; },
    limit() { return query; },
    maybeSingle() { return Promise.resolve(resolve()); },
    single() { return Promise.resolve(resolve()); },
    then(onFulfilled: any, onRejected: any) {
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };

  function resolve() {
    state.reads.push(table);
    if (table === "retention_candidates") {
      return { data: state.candidate, error: state.candidateError };
    }
    if (table === "messages" && operation === "select") {
      return {
        data: [{
          id: MESSAGE_ID,
          player_id: PLAYER_ID,
          body: "Approved text",
          signup_url: null,
          approved_at: "2026-01-01T12:00:00.000Z",
          players: { phone: "+15551234567", club_id: CLUB_ID },
        }],
        error: null,
      };
    }
    return { data: null, error: null };
  }

  return query;
}

function reset(candidate: any, candidateError: { message: string } | null = null) {
  state.candidate = candidate;
  state.candidateError = candidateError;
  state.updates = [];
  state.reads = [];
  process.env.RETENTION_ONLY_MODE = "true";
  process.env.SMS_LIVE = "true";
  (supabase as any).from = (table: string) => queryFor(table);
}

test("queue poller leaves unlinked, unapproved, and unverifiable messages untouched", async () => {
  const cases = [
    { candidate: null, error: null },
    {
      candidate: {
        message_id: MESSAGE_ID,
        player_id: PLAYER_ID,
        club_id: CLUB_ID,
        status: "drafted",
      },
      error: null,
    },
    { candidate: null, error: { message: "candidate DB unavailable" } },
  ];

  for (const item of cases) {
    reset(item.candidate, item.error);
    const stats = await runQueueTick();
    assert.equal(stats.processed, 1);
    assert.equal(stats.skipped, 1);
    assert.equal(stats.sent, 0);
    assert.deepEqual(state.updates, []);
    assert.deepEqual(state.reads, ["messages", "retention_candidates"]);
  }
});

test("queue poller test environment is restored", () => {
  (supabase as any).from = originalSupabaseFrom;
  if (originalRetentionMode === undefined) delete process.env.RETENTION_ONLY_MODE;
  else process.env.RETENTION_ONLY_MODE = originalRetentionMode;
  if (originalSmsLive === undefined) delete process.env.SMS_LIVE;
  else process.env.SMS_LIVE = originalSmsLive;
});
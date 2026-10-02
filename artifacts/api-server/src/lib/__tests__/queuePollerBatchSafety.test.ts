import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { supabase } from "../supabaseClient";
import { runQueueTick, setQueueBookingOptionsFactoryForTests } from "../queuePoller";
import { setTwilioClientFactoryForTests, setTwilioClockForTests } from "../twilio";
import { RetentionPodplayBatchClient } from "../retentionPodplayBatch";
import { recheckLtpSequenceDispatch } from "../ltpSequenceLifecycle";
import { VirtualClock } from "./virtualClock";

const originals = {
  from: supabase.from, rpc: supabase.rpc, env: { ...process.env },
};
const clubId = "00000000-0000-4000-8000-000000000001";
const playerId = "00000000-0000-4000-8000-000000000002";
const futureStart = new Date(Date.now() + 4 * 86_400_000).toISOString();
const suggested = { id: "suggested", name: "Beginner session", startTime: futureStart, status: "PUBLISHED", totalTeams: 8 };
let messages: any[];
let candidates: any[];
let paused: boolean;
let calls: string[];
let submissions: string[];
let pauseAfterFirst: boolean;
let snapshotFails: boolean;
let eventCount: number;
let clock: VirtualClock | undefined;
let messageStarted: Map<string, number>;
let messageSubmitted: Map<string, number>;

function fakeQuery(table: string) {
  const filters: Record<string, any> = {};
  let op = "read";
  let changes: any;
  const q: any = {
    select: () => q, order: () => q, limit: () => q,
    eq: (key: string, value: any) => { filters[key] = value; return q; },
    is: (key: string, value: any) => { filters[key] = value; return q; },
    not: () => q, neq: () => q, lte: () => q, gt: () => q,
    update: (value: any) => { op = "update"; changes = value; return q; },
    insert: () => { op = "insert"; return q; },
    maybeSingle: async () => resolve(),
    single: async () => resolve(),
    then: (yes: any, no: any) => Promise.resolve(resolve()).then(yes, no),
  };
  function resolve() {
    let data: any = null;
    if (table === "messages") {
      if (filters.id === "step-one-message") {
        data = { status: "sent", simulated: false, retention_delivery_kind: "real", sent_at: "2026-01-13T17:00:00Z" };
      } else if (filters.id) {
        data = messages.find((m) => m.id === filters.id);
        if (op === "read" && !messageStarted.has(filters.id)) messageStarted.set(filters.id, Date.now());
        if (op === "update") Object.assign(data, changes);
      } else data = messages.filter((m) => m.status === "pending");
    } else if (table === "clubs") {
      data = { sms_kill_switch: paused };
    } else if (table === "players") {
      data = { id: playerId, club_id: clubId, external_id: "pod-player", phone: "+15551234567", opted_out: false };
    } else if (table === "retention_candidates") {
      data = filters.step === 1 ? { id: "step-one", message_id: "step-one-message" }
        : candidates.find((c) => c.message_id === filters.message_id || c.id === filters.id);
      if (op === "update" && data) Object.assign(data, changes);
    } else if (table === "retention_sequences") {
      data = { sequence_status: "active", step1_sent_at: "2026-01-13T17:00:00Z", step1_delivery_kind: "real" };
    } else if (table === "attendances") {
      data = [];
    }
    return { data, error: null };
  }
  return q;
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.SMS_LIVE = "true";
  process.env.RETENTION_ONLY_MODE = "true";
  delete process.env.REQUIRE_MARKETING_CONSENT;
  delete process.env.SMS_TEST_OVERRIDE_TO;
  messages = ["one", "two"].map((id) => ({
    id, player_id: playerId, status: "pending", body: `Approved ${id}`,
    approved_body: `Approved ${id}`, approved_by: "Offline operator", approved_at: "2026-01-15T16:00:00Z",
    scheduled_send_at: "2026-01-15T16:01:00Z", dispatch_claimed_at: null,
    players: { club_id: clubId, phone: "+15551234567" },
  }));
  candidates = messages.map((m) => ({
    id: `candidate-${m.id}`, message_id: m.id, player_id: playerId, club_id: clubId,
    status: "approved", playbook_key: "ltp_followup", step: 2, sequence_id: "sequence",
    sequence_status: "active", updated_at: "2026-01-15T16:00:00Z",
    context: {
      variant: "with_program", ltp_text: { step: 2 }, promo: null,
      next_program: {
        event_id: suggested.id, start_time: futureStart,
        name: suggested.name, signup_url: "https://offline.podplay.app/community/events/suggested",
      },
    },
  }));
  paused = false;
  calls = [];
  submissions = [];
  pauseAfterFirst = false;
  snapshotFails = false;
  eventCount = 2;
  clock = undefined;
  messageStarted = new Map();
  messageSubmitted = new Map();
  (supabase as any).from = fakeQuery;
  (supabase as any).rpc = async (name: string, args: any) => {
    if (name === "retention_sequence_ready") return { data: true, error: null };
    if (name === "retention_sequence_claim") {
      const msg = messages.find((m) => m.id === args.p_message_id)!;
      msg.dispatch_claimed_at = args.p_claimed_at;
      return { data: { id: msg.id }, error: null };
    }
    return { data: { sequence_status: "active" }, error: null };
  };
  setTwilioClockForTests(() => new Date("2026-01-15T17:00:00Z"));
  setTwilioClientFactoryForTests(() => ({
    messages: { create: async ({ body }: { body: string }) => {
      submissions.push(body);
      messageSubmitted.set(body.replace("Approved ", ""), Date.now());
      if (pauseAfterFirst) paused = true;
      return { sid: `SM-offline-${submissions.length}` };
    } },
  } as any));
  setQueueBookingOptionsFactoryForTests(() => ({
    client: new RetentionPodplayBatchClient({
      minimumSpacingMs: 0, maxConcurrentRequests: 6, maxRequestsPerMinute: 285,
      ...(clock ? { sleep: clock.sleep } : {}),
      fetchImpl: fakeProvider,
    }),
    clubCache: new Map([[clubId, Promise.resolve({ base: "https://offline.podplay.app", apiKey: "offline", timezone: "America/New_York" })]]),
    eventsCache: new Map(), signupsCache: new Map(),
  }));
});

async function fakeProvider(input: any): Promise<Response> {
  if (clock) await clock.sleep(80);
  const url = new URL(String(input));
  calls.push(url.pathname);
  if (url.pathname === "/apis/v2/events") {
    if (snapshotFails) return new Response("Offline snapshot failure", { status: 503 });
    return Response.json({ items: [
      suggested, ...Array.from({ length: eventCount - 1 }, (_, i) => ({
        ...suggested, id: i === 0 ? "far-away" : `future-${i}`,
        startTime: new Date(Date.now() + 400 * 86_400_000).toISOString(),
      })),
    ] });
  }
  if (url.pathname.endsWith("/signups")) return Response.json({ items: [] });
  if (url.pathname.endsWith("/suggested")) return Response.json({ item: suggested });
  throw new Error(`Unexpected offline request ${url.pathname}`);
}

after(() => {
  setQueueBookingOptionsFactoryForTests(null);
  setTwilioClockForTests(null);
  setTwilioClientFactoryForTests(null);
  (supabase as any).from = originals.from;
  (supabase as any).rpc = originals.rpc;
  for (const key of ["NODE_ENV", "SMS_LIVE", "RETENTION_ONLY_MODE", "REQUIRE_MARKETING_CONSENT", "SMS_TEST_OVERRIDE_TO"]) {
    if (originals.env[key] === undefined) delete process.env[key];
    else process.env[key] = originals.env[key];
  }
});

test("pause between two batch messages blocks the second; Resume dispatches it next tick", async () => {
  pauseAfterFirst = true;
  const first = await runQueueTick();
  assert.equal(first.sent, 1);
  assert.equal(first.skipped, 1);
  assert.deepEqual(submissions, ["Approved one"]);
  assert.equal(messages[1].status, "pending");
  assert.ok(messages[1].approved_at);
  assert.equal(messages[1].scheduled_send_at, "2026-01-15T16:01:00Z");
  assert.equal(messages[1].dispatch_claimed_at, null);
  paused = false;
  pauseAfterFirst = false;
  const resumed = await runQueueTick();
  assert.equal(resumed.sent, 1);
  assert.deepEqual(submissions, ["Approved one", "Approved two"]);
});

test("snapshot failure sends nothing and leaves both approvals, schedules, and claims untouched", async () => {
  snapshotFails = true;
  const before = JSON.stringify(messages);
  const stats = await runQueueTick();
  assert.equal(stats.sent, 0);
  assert.equal(stats.failed, 2);
  assert.deepEqual(submissions, []);
  assert.equal(JSON.stringify(messages), before);
});

test("one future snapshot serves both messages; suggested event and capacity are freshly checked twice each", async () => {
  const stats = await runQueueTick();
  assert.equal(stats.sent, 2);
  assert.equal(calls.filter((url) => url === "/apis/v2/events").length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/far-away/signups")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/suggested")).length, 4);
  assert.equal(calls.filter((url) => url.endsWith("/suggested/signups")).length, 5);
});

test("before/after benchmark exercises booking checks and the full mocked dispatch path at 244 events", async () => {
  const realNow = Date.now;
  clock = new VirtualClock();
  Date.now = () => clock!.now;
  eventCount = 244;
  const before: number[] = [];
  try {
    // The previous strategy: scan every event twice per message, serialized,
    // waiting 400ms after each response. Same fake HTTP latency and coverage.
    const oldClient = new RetentionPodplayBatchClient({
      minimumSpacingMs: 400, sleep: clock.sleep, fetchImpl: fakeProvider,
    });
    const clubCache = new Map([[clubId, Promise.resolve({
      base: "https://offline.podplay.app", apiKey: "offline", timezone: "America/New_York",
    })]]);
    for (const candidate of candidates) {
      const started = clock.now;
      const body = messages.find((message) => message.id === candidate.message_id)!.approved_body;
      await recheckLtpSequenceDispatch(candidate, { client: oldClient, clubCache }, body);
      await recheckLtpSequenceDispatch(candidate, { client: oldClient, clubCache }, body);
      before.push(clock.now - started);
    }
    calls = [];
    const tickStarted = clock.now;
    const stats = await runQueueTick();
    const after = messages.map((m) => messageSubmitted.get(m.id)! - messageStarted.get(m.id)!);
    const totalTick = clock.now - tickStarted;
    assert.equal(stats.sent, 2);
    assert.ok(after.every((ms) => ms < 30_000));
    assert.ok(totalTick / 2 < 30_000, "including shared snapshot cost, amortized over two messages");
    assert.equal(calls.filter((url) => url === "/apis/v2/events").length, 1);
    console.log("OFFLINE_DISPATCH_BENCHMARK " + JSON.stringify({
      type: "deterministic virtual-clock, no real HTTP or SMS",
      events: eventCount, messages: 2, mock_http_latency_ms: 80,
      before_ms_per_message: before, after_ms_per_message: after,
      shared_snapshot_ms: messageStarted.get("one")! - tickStarted,
      total_tick_ms: totalTick, amortized_ms_per_message: totalTick / 2,
      first_provider_submission_since_tick_ms: messageSubmitted.get("one")! - tickStarted,
    }));
  } finally {
    Date.now = realNow;
  }
});
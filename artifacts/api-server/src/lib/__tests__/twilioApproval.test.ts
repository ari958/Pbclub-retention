import assert from "node:assert/strict";
import { test } from "node:test";
import { supabase } from "../supabaseClient.js";
import {
  isSmsDispatchClaimError,
  isSmsPolicyBlockedError,
  recordSmsDispatchFailure,
  sendViaTwilio,
  setTwilioClientFactoryForTests,
  setTwilioClockForTests,
  setLtpSequenceBatchOptionsFactoryForTests,
} from "../twilio.js";
import { RetentionPodplayBatchClient } from "../retentionPodplayBatch.js";

type DbResult = { data?: any; error?: { message: string } | null };

const originalEnv = {
  nodeEnv: process.env.NODE_ENV,
  smsLive: process.env.SMS_LIVE,
  override: process.env.SMS_TEST_OVERRIDE_TO,
  consent: process.env.REQUIRE_MARKETING_CONSENT,
  retentionOnly: process.env.RETENTION_ONLY_MODE,
};
const originalSupabaseFrom = (supabase as any).from;
const originalSupabaseRpc = (supabase as any).rpc;
const MESSAGE_ID = "00000000-0000-4000-8000-000000000001";
const PLAYER_ID = "00000000-0000-4000-8000-000000000002";
const CLUB_ID = "00000000-0000-4000-8000-000000000003";

const state: {
  message: any;
  player: any;
  candidate: any;
  candidateError?: { message: string } | null;
  club: DbResult;
  clubReads?: DbResult[];
  attendanceRows?: any[];
  stepOneCandidate?: any;
  stepOneMessage?: any;
  casRace: boolean;
  transportError?: Error;
  transportCalls: number;
  sends: Array<{ body: string; to: string }>;
  ledger: any[];
  rpcCalls: Array<{ name: string; args: any }>;
  sequenceTransitionError?: { message: string } | null;
} = {
  message: {},
  player: {},
  candidate: {},
  club: { data: { sms_kill_switch: false }, error: null },
  casRace: false,
  transportCalls: 0,
  sends: [],
  ledger: [],
  rpcCalls: [],
};

function queryFor(table: string) {
  let operation = "select";
  let values: any;
  const filters: Record<string, any> = {};
  const query: any = {
    select() { return query; },
    update(next: any) { operation = "update"; values = next; return query; },
    insert(next: any) { operation = "insert"; values = next; return query; },
    eq(key: string, value: any) { filters[key] = value; return query; },
    gt(key: string, value: any) { filters[key] = value; return query; },
    is(key: string, value: any) { filters[key] = value; return query; },
    neq(key: string, value: any) { filters[key] = { neq: value }; return query; },
    not(key: string, operator: string, value: any) { filters[key] = { operator, value }; return query; },
    order() { return query; },
    limit() { return query; },
    maybeSingle() { return Promise.resolve(resolve()); },
    single() { return Promise.resolve(resolve()); },
    then(onFulfilled: any, onRejected: any) {
      if (table === "attendances" && operation === "select") {
        return Promise.resolve({ data: state.attendanceRows ?? [], error: null }).then(onFulfilled, onRejected);
      }
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };

  function resolve(): DbResult {
    if (operation === "select") {
      if (table === "messages") {
        return {
          data: filters.id && filters.id !== state.message.id ? state.stepOneMessage : state.message,
          error: null,
        };
      }
      if (table === "players") return { data: state.player, error: null };
      if (table === "clubs") return state.clubReads?.shift() ?? state.club;
      if (table === "contact_ledger") return { data: null, error: null };
      if (table === "retention_candidates") {
        return {
          data: filters.step === 1 ? state.stepOneCandidate ?? state.candidate : state.candidate,
          error: state.candidateError ?? null,
        };
      }
      if (table === "retention_sequences") {
        return {
          data: {
            sequence_status: "active",
            step1_sent_at: "2026-01-13T17:00:00.000Z",
            step1_delivery_kind: "real",
          },
          error: null,
        };
      }
      if (table === "attendances" && filters.event_id) {
        return { data: { attended_at: "2026-01-13T17:00:00.000Z" }, error: null };
      }
    }
    if (table === "messages" && operation === "update") {
      if (filters.status && state.message.status !== filters.status) {
        return { data: null, error: null };
      }
      if (filters.dispatch_token && state.message.dispatch_token !== filters.dispatch_token) {
        return { data: null, error: null };
      }
      if (values.dispatch_token) {
        if (state.casRace) {
          state.message = { ...state.message, status: "sent", dispatch_token: "winning-dispatch-token" };
          return { data: null, error: null };
        }
        if (state.message.dispatch_token || state.message.dispatch_claimed_at) {
          return { data: null, error: null };
        }
        state.message = { ...state.message, ...values };
        return { data: { id: state.message.id }, error: null };
      }
      state.message = { ...state.message, ...values };
      return { data: state.message, error: null };
    }
    if (table === "contact_ledger" && operation === "insert") {
      state.ledger.push(values);
      return { data: values, error: null };
    }
    if (table === "players" && operation === "update") {
      state.player = { ...state.player, ...values };
      return { data: state.player, error: null };
    }
    if (table === "retention_candidates" && operation === "update") {
      if (
        !state.candidate
        ||
        filters.id !== state.candidate.id
        || filters.club_id !== state.candidate.club_id
        || filters.status !== "drafted"
        || filters.updated_at !== state.candidate.updated_at
        || filters.context !== JSON.stringify(state.candidate.context)
      ) {
        return { data: null, error: null };
      }
      state.candidate = { ...state.candidate, ...values, updated_at: "2026-01-15T16:00:00.456Z" };
      return {
        data: { id: state.candidate.id, context: state.candidate.context, updated_at: state.candidate.updated_at },
        error: null,
      };
    }
    return { data: null, error: null };
  }

  return query;
}

async function mockRpc(name: string, args: any) {
  state.rpcCalls.push({ name, args });
  if (name === "retention_sequence_ready") return { data: true, error: null };
  if (name === "retention_sequence_session_changed") {
    state.message = {
      ...state.message,
      status: "pending",
      approved_at: null,
      approved_by: null,
      approved_body: null,
      scheduled_send_at: null,
      dispatch_claimed_at: null,
      dispatch_token: null,
    };
    const context = { ...state.candidate.context };
    delete context.ltp_text;
    const returned = {
      ...state.candidate,
      status: "drafted",
      updated_at: "2026-01-15T16:00:00.123Z",
      context: {
        ...context,
        reason: "session_changed",
        errors: ["Suggested session changed; rebuild context and re-review"],
      },
    };
    state.candidate = returned;
    return { data: returned, error: null };
  }
  if (name === "retention_sequence_transition" && state.sequenceTransitionError) {
    return { data: null, error: state.sequenceTransitionError };
  }
  return { data: { sequence_status: args?.p_status ?? "ready" }, error: null };
}

function reset(options: {
  approved?: boolean;
  kill?: DbResult;
  clubReads?: DbResult[];
  casRace?: boolean;
  transportError?: Error;
  candidate?: any;
  candidateError?: { message: string } | null;
} = {}) {
  state.message = {
    id: MESSAGE_ID,
    body: "Thanks for coming by!",
    signup_url: null,
    approved_at: options.approved === false ? null : "2026-01-01T12:00:00.000Z",
    approved_by: options.approved === false ? null : "operator@example.test",
    approved_body: options.approved === false ? null : "Thanks for coming by!",
    status: "pending",
    player_id: PLAYER_ID,
    conversation_id: null,
    dispatch_claimed_at: null,
    dispatch_token: null,
  };
  state.player = {
    id: PLAYER_ID,
    phone: "+15551234567",
    opted_out: false,
    external_id: "podplay-player",
    sms_opt_in: false,
    consent_source: null,
    sms_consented_at: null,
    club_id: CLUB_ID,
  };
  state.candidate = options.candidate === undefined
    ? {
        id: "00000000-0000-4000-8000-000000000004",
        message_id: MESSAGE_ID,
        player_id: PLAYER_ID,
        club_id: CLUB_ID,
        status: "approved",
        context: null,
      }
    : options.candidate;
  state.candidateError = options.candidateError;
  state.club = options.kill ?? { data: { sms_kill_switch: false }, error: null };
  state.clubReads = options.clubReads;
  state.casRace = options.casRace ?? false;
  state.transportError = options.transportError;
  state.transportCalls = 0;
  state.sends = [];
  state.ledger = [];
  state.rpcCalls = [];
  state.sequenceTransitionError = undefined;
  state.attendanceRows = [];
  state.stepOneCandidate = {
    id: "step-one",
    message_id: "step-one-message",
  };
  state.stepOneMessage = {
    status: "sent",
    sent_at: "2026-01-13T17:00:00.000Z",
    simulated: false,
    retention_delivery_kind: "real",
  };
}

async function invoke() {
  return sendViaTwilio(state.player.phone, state.message.approved_body ?? "Thanks for coming by!", {
    messageId: state.message.id,
    source: "retention",
    purpose: "promotion",
  });
}

process.env.NODE_ENV = "test";
process.env.SMS_LIVE = "true";
process.env.RETENTION_ONLY_MODE = "true";
delete process.env.REQUIRE_MARKETING_CONSENT;
setTwilioClockForTests(() => new Date("2026-01-15T17:00:00.000Z")); // Thursday, noon ET.
setTwilioClientFactoryForTests(() => ({
  messages: {
    create: async ({ body, to }: { body: string; to: string }) => {
      state.transportCalls++;
      if (state.transportError) throw state.transportError;
      state.sends.push({ body, to });
      return { sid: "SM-test" };
    },
  },
} as any));
(supabase as any).from = (table: string) => queryFor(table);
(supabase as any).rpc = mockRpc;

test("unapproved message is blocked before transport", async () => {
  reset({ approved: false });
  await assert.rejects(invoke(), /not explicitly approved/);
  assert.equal(state.sends.length, 0);
  assert.equal(state.transportCalls, 0);
  assert.equal(state.ledger.length, 0);
});

test("retention dispatch blocks messages with no linked candidate before claim", async () => {
  reset({ candidate: null });
  await assert.rejects(invoke(), /requires an approved retention candidate linked to this message/);
  assert.equal(state.sends.length, 0);
  assert.equal(state.transportCalls, 0);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.message.dispatch_token, null);
  assert.equal(state.message.status, "pending");
});

test("approved retention candidate and approved linked message can dispatch through the mock transport", async () => {
  reset();
  const result = await invoke();
  assert.equal(result.sid, "SM-test");
  assert.equal(state.transportCalls, 1);
  assert.equal(state.sends.length, 1);
  assert.equal(state.message.status, "sent");
});

test("LTP dispatch fails closed before transport until sequence schema readiness passes", async () => {
  reset({
    candidate: {
      id: "00000000-0000-4000-8000-000000000004",
      message_id: MESSAGE_ID,
      player_id: PLAYER_ID,
      club_id: CLUB_ID,
      playbook_key: "ltp_followup",
      status: "approved",
      step: 1,
      sequence_id: "00000000-0000-4000-8000-000000000005",
      sequence_status: "active",
      context: { ltp_text: { step: 1 } },
      updated_at: "2026-01-01T12:00:00.000Z",
    },
  });
  (supabase as any).rpc = async (name: string) => {
    assert.equal(name, "retention_sequence_ready");
    return { data: false, error: null };
  };
  try {
    await assert.rejects(invoke(), /migration 013 is installed and ready/);
    assert.equal(state.transportCalls, 0);
    assert.equal(state.sends.length, 0);
    assert.equal(state.ledger.length, 0);
    assert.equal(state.message.dispatch_claimed_at, null);
    assert.equal(state.message.dispatch_token, null);
  } finally {
    (supabase as any).rpc = mockRpc;
  }
});

test("Twilio blocks changed sessions and returns step 1 and step 2 to unapproved review", async () => {
  const eventId = "00000000-0000-4000-8000-000000000024";
  const triggerId = "00000000-0000-4000-8000-000000000025";
  const oldStart = "2026-10-04T14:30:00.000Z";
  const newStart = "2026-10-04T15:00:00.000Z";
  const sessionChange = {
    old_start_time: oldStart,
    new_start_time: newStart,
    reason: "start_time_changed",
  };
  const fixtureCandidate = (step: 1 | 2) => ({
    id: `candidate-step-${step}`,
    message_id: MESSAGE_ID,
    player_id: PLAYER_ID,
    club_id: CLUB_ID,
    playbook_key: "ltp_followup",
    trigger_event_id: triggerId,
    status: "approved",
    step,
    sequence_id: "sequence",
    sequence_status: "active",
    updated_at: "2026-01-15T16:00:00.000Z",
    context: {
      variant: "with_program",
      trigger: { event_id: triggerId, name: "Learn to Play", date: "2026-01-13" },
      player_first_name: "Sam",
      next_program: {
        event_id: eventId,
        name: "Beginner Session",
        start_time: oldStart,
        date: "2026-10-04",
        time: "10:30 AM",
        signup_url: `https://test.podplay.app/community/events/${eventId}`,
        spots_remaining: 2,
      },
      classmates_signed_up: 0,
      already_booked: false,
      booked_event: null,
      promo: step === 1 ? { code: "LTPNEXT25", offer_text: "25% off your next program" } : null,
      coupon_warning: null,
      evaluated_at: "2026-01-15T16:00:00.000Z",
      diagnostics: { source: "test-fixture" },
      ltp_text: {
        step,
        seed_nonce: 13,
        slot_indices: { opener: 1, next_step: 2 },
        slot_templates: { opener: "Hi Sam", next_step: "{program} on {when}" },
        opener: "Hi Sam",
        ltp_date: "Jan 13",
        when: "Sunday, Oct 4 at 10:30am",
      },
    },
  });

  setLtpSequenceBatchOptionsFactoryForTests(() => {
    const client = new RetentionPodplayBatchClient({
      minimumSpacingMs: 0,
      sleep: async () => {},
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(`/events/${triggerId}`)) {
          return Response.json({
            item: {
              id: triggerId,
              name: "Learn to Play",
              startTime: "2026-01-13T17:00:00.000Z",
              status: "PUBLISHED",
              isCanceled: false,
            },
          });
        }
        if (url.pathname === "/apis/v2/events") return Response.json({ items: [] });
        if (url.pathname.endsWith(`/events/${eventId}/signups`)) return Response.json({ items: [] });
        if (url.pathname.endsWith(`/events/${eventId}`)) {
          return Response.json({
            item: {
              id: eventId,
              name: "Beginner Session",
              startTime: newStart,
              status: "PUBLISHED",
              isCanceled: false,
              totalTeams: 4,
            },
          });
        }
        throw new Error(`Unexpected PodPlay test URL ${url.pathname}`);
      },
    });
    return {
      client,
      clubCache: new Map([[CLUB_ID, Promise.resolve({
        base: "https://test.podplay.app",
        apiKey: "offline-test-key",
        timezone: "America/New_York",
      })]]),
      eventsCache: new Map<string, Promise<any[]>>(),
      signupsCache: new Map<string, Promise<any[]>>(),
    };
  });

  try {
    for (const step of [1, 2] as const) {
      reset({ candidate: fixtureCandidate(step) });
      const before = state.candidate.context.diagnostics;
      await assert.rejects(invoke(), /returned for review/);
      assert.equal(state.transportCalls, 0);
      assert.equal(state.sends.length, 0);
      assert.equal(state.message.status, "pending");
      assert.equal(state.message.approved_at, null);
      assert.equal(state.message.approved_by, null);
      assert.equal(state.message.approved_body, null);
      assert.equal(state.candidate.status, "drafted");
      assert.deepEqual(state.candidate.context.diagnostics, before);
      assert.deepEqual(state.candidate.context.session_change, sessionChange);
      assert.equal(state.candidate.context.reason, "session_changed");
      assert.equal(state.candidate.context.ltp_text.step, step);
      assert.equal(state.candidate.context.ltp_text.seed_nonce, 13);
      assert.deepEqual(state.candidate.context.ltp_text.slot_indices, { opener: 1, next_step: 2 });
      assert.ok(state.rpcCalls.some((call) =>
        call.name === "retention_sequence_session_changed"
        && call.args.p_candidate_id === state.candidate.id,
      ));
    }
  } finally {
    setLtpSequenceBatchOptionsFactoryForTests(null);
  }
});

test("retention dispatch requires approved candidate state and linked-message approval timestamp", async () => {
  reset();
  for (const candidate of [{ ...state.candidate, status: "drafted" }]) {
    reset({ candidate });
    await assert.rejects(invoke(), /candidate and linked message have not been explicitly approved/);
    assert.equal(state.sends.length, 0);
    assert.equal(state.transportCalls, 0);
    assert.equal(state.message.dispatch_token, null);
  }

  reset({ approved: false });
  await assert.rejects(invoke(), /not explicitly approved/);
  assert.equal(state.sends.length, 0);
  assert.equal(state.message.dispatch_token, null);
});

test("retention candidate must be associated to the exact message, player and active club", async () => {
  reset();
  for (const candidate of [
    { ...state.candidate, message_id: "00000000-0000-4000-8000-000000000099" },
    { ...state.candidate, player_id: "00000000-0000-4000-8000-000000000099" },
    { ...state.candidate, club_id: "00000000-0000-4000-8000-000000000099" },
  ]) {
    reset({ candidate });
    await assert.rejects(invoke(), /does not match this message, player, and active club/);
    assert.equal(state.sends.length, 0);
    assert.equal(state.message.dispatch_token, null);
  }
});

test("retention candidate read failures fail closed before the dispatch claim", async () => {
  reset({ candidateError: { message: "candidate read failed" } });
  await assert.rejects(invoke(), /approval could not be verified: candidate read failed/);
  assert.equal(state.sends.length, 0);
  assert.equal(state.transportCalls, 0);
  assert.equal(state.message.dispatch_token, null);
  assert.equal(state.message.status, "pending");
});

test("missing retention candidate remains permitted when retention-only mode is disabled", async () => {
  process.env.RETENTION_ONLY_MODE = "false";
  reset({ candidate: null });
  try {
    const result = await invoke();
    assert.equal(result.sid, "SM-test");
    assert.equal(state.transportCalls, 1);
    assert.equal(state.sends.length, 1);
  } finally {
    process.env.RETENTION_ONLY_MODE = "true";
  }
});

test("approved body mismatch is blocked before transport", async () => {
  reset();
  state.message.approved_body = "A different reviewed body";
  await assert.rejects(invoke(), /does not match its approved body/);
  assert.equal(state.sends.length, 0);
  assert.equal(state.transportCalls, 0);
  assert.equal(state.message.dispatch_token, null);
});

test("STOP/opt-out blocks dispatch before claim and contact", async () => {
  reset();
  state.player.opted_out = true;
  await assert.rejects(invoke(), /not text eligible/);
  assert.equal(state.sends.length, 0);
  assert.equal(state.transportCalls, 0);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.message.status, "pending");
  assert.equal(state.message.dispatch_token, null);
});

test("missing message context is blocked even for dry-run calls", async () => {
  reset();
  process.env.SMS_LIVE = "false";
  try {
    await assert.rejects(sendViaTwilio(state.player.phone, state.message.approved_body), /requires an approved messageId context/);
    assert.equal(state.sends.length, 0);
    assert.equal(state.transportCalls, 0);
  } finally {
    process.env.SMS_LIVE = "true";
  }
});

test("engaged and unavailable kill switches fail closed", async () => {
  for (const kill of [
    { data: { sms_kill_switch: true }, error: null },
    { data: null, error: null },
    { data: null, error: { message: "read failed" } },
  ]) {
    reset({ kill });
    await assert.rejects(invoke(), /kill switch/);
    assert.equal(state.sends.length, 0);
    assert.equal(state.transportCalls, 0);
    assert.equal(state.ledger.length, 0);
    assert.equal(state.message.status, "pending");
    assert.equal(state.message.dispatch_token, null);
  }
});

test("a kill-switch change after claim releases the pending approval for retry", async () => {
  reset({
    clubReads: [
      { data: { sms_kill_switch: false }, error: null },
      { data: { sms_kill_switch: true }, error: null },
    ],
  });
  await assert.rejects(invoke(), (error: any) => isSmsPolicyBlockedError(error));
  assert.equal(state.sends.length, 0);
  assert.equal(state.transportCalls, 0);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.message.status, "pending");
  assert.equal(state.message.dispatch_token, null);
  assert.equal(state.message.dispatch_claimed_at, null);
});

test("dispatch claim compare-and-set blocks a concurrent duplicate", async () => {
  reset({ casRace: true });
  let claimError: unknown;
  await assert.rejects(invoke(), (error: any) => {
    claimError = error;
    return isSmsDispatchClaimError(error);
  });
  await recordSmsDispatchFailure(claimError);
  assert.equal(state.sends.length, 0);
  assert.equal(state.transportCalls, 0);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.message.status, "sent");
  assert.equal(state.message.dispatch_token, "winning-dispatch-token");
});

test("live transport failure retains the dispatch claim for reconciliation", async () => {
  reset({ transportError: new Error("Twilio unavailable") });
  let sendError: unknown;
  await assert.rejects(invoke(), (error: any) => {
    sendError = error;
    return /Twilio unavailable/.test(error.message);
  });
  await recordSmsDispatchFailure(sendError);
  assert.equal(state.sends.length, 0);
  assert.equal(state.transportCalls, 1);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.message.status, "failed");
  assert.ok(state.message.dispatch_token);
  assert.ok(state.message.dispatch_claimed_at);
});

test("synchronous Twilio 21610 failure persists permanent opt-out and exits the LTP sequence", async () => {
  const error = Object.assign(new Error("Recipient opted out"), { code: 21610 });
  reset({ transportError: error });
  let sendError: unknown;
  await assert.rejects(invoke(), (failure: any) => {
    sendError = failure;
    return /Recipient opted out/.test(failure.message);
  });
  await recordSmsDispatchFailure(sendError);
  assert.equal(state.message.status, "failed");
  assert.equal(state.player.opted_out, true);
  assert.equal(state.player.sms_opt_in, false);
  assert.ok(state.rpcCalls.some((call) =>
    call.name === "retention_sequence_transition"
    && call.args.p_status === "exited_opt_out"
    && call.args.p_reason === "twilio_error_21610",
  ));
});

test("redirected live send is ledgered as a test without original-player contact", async () => {
  reset();
  state.player.last_outbound_at = "2026-01-15T16:59:00.000Z";
  process.env.SMS_TEST_OVERRIDE_TO = "+15550000000";
  try {
    const result = await invoke();
    assert.equal(result.sid, "SM-test");
    assert.equal(result.simulated, false);
    assert.equal(result.isTest, true);
    assert.deepEqual(state.sends, [{ body: "Thanks for coming by!", to: "+15550000000" }]);
    assert.equal(state.transportCalls, 1);
    assert.equal(state.ledger.length, 1);
    assert.equal(state.ledger[0].is_test, true);
    assert.equal(state.ledger[0].player_id, null);
    assert.equal(state.ledger[0].intended_player_id, PLAYER_ID);
    assert.equal(state.ledger[0].message_id, MESSAGE_ID);
    assert.equal(state.ledger[0].purpose, "promotion");
    assert.equal(state.player.last_outbound_at, "2026-01-15T16:59:00.000Z");
  } finally {
    delete process.env.SMS_TEST_OVERRIDE_TO;
  }
});

test("test environment is restored", () => {
  setTwilioClientFactoryForTests(null);
  setTwilioClockForTests(null);
  setLtpSequenceBatchOptionsFactoryForTests(null);
  (supabase as any).rpc = originalSupabaseRpc;
  if (originalEnv.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv.nodeEnv;
  if (originalEnv.smsLive === undefined) delete process.env.SMS_LIVE;
  else process.env.SMS_LIVE = originalEnv.smsLive;
  if (originalEnv.override === undefined) delete process.env.SMS_TEST_OVERRIDE_TO;
  else process.env.SMS_TEST_OVERRIDE_TO = originalEnv.override;
  if (originalEnv.consent === undefined) delete process.env.REQUIRE_MARKETING_CONSENT;
  else process.env.REQUIRE_MARKETING_CONSENT = originalEnv.consent;
  if (originalEnv.retentionOnly === undefined) delete process.env.RETENTION_ONLY_MODE;
  else process.env.RETENTION_ONLY_MODE = originalEnv.retentionOnly;
  (supabase as any).from = originalSupabaseFrom;
});
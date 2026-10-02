import assert from "node:assert/strict";
import { test } from "node:test";
import { RetentionPodplayBatchClient } from "../retentionPodplayBatch.js";
import {
  recheckLtpSequenceDispatch,
  returnLtpSequenceForSessionReview,
} from "../ltpSequenceLifecycle.js";
import { supabase } from "../supabaseClient.js";
import type { RetentionCandidate } from "../retentionTypes.js";

const originalFrom = (supabase as any).from;
const originalRpc = (supabase as any).rpc;
const CLUB_ID = "00000000-0000-4000-8000-000000000121";
const PLAYER_ID = "00000000-0000-4000-8000-000000000122";
const TRIGGER_ID = "00000000-0000-4000-8000-000000000123";
const EVENT_ID = "00000000-0000-4000-8000-000000000124";
const CUTOFF = "2026-09-01T12:00:00.000Z";
const OLD_START = "2026-10-04T14:30:00.000Z";
const NEW_START = "2026-10-04T15:00:00.000Z";

const state: {
  attendanceRows: any[];
  event: any;
  signups: any[];
  requests: string[];
  sequence: any;
  stepOneCandidate: any;
  stepOneMessage: any;
} = {
  attendanceRows: [],
  event: {},
  signups: [],
  requests: [],
  sequence: {},
  stepOneCandidate: {},
  stepOneMessage: {},
};

function reset(options: {
  attendanceRows?: any[];
  event?: any;
  signups?: any[];
} = {}) {
  state.attendanceRows = options.attendanceRows ?? [];
  state.event = options.event ?? {
    id: EVENT_ID,
    name: "Beginner Session",
    startTime: OLD_START,
    status: "PUBLISHED",
    isCanceled: false,
    totalTeams: 2,
  };
  state.signups = options.signups ?? [];
  state.requests = [];
  state.sequence = {
    sequence_status: "active",
    step1_sent_at: "2026-09-03T14:00:00.000Z",
    step1_delivery_kind: "real",
  };
  state.stepOneCandidate = { id: "step-one", message_id: "step-one-message" };
  state.stepOneMessage = {
    status: "sent",
    sent_at: "2026-09-03T14:00:00.000Z",
    simulated: false,
    retention_delivery_kind: "real",
  };

  (supabase as any).from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const query: any = {
      select() { return query; },
      eq(key: string, value: unknown) { filters[key] = value; return query; },
      gt(key: string, value: unknown) { filters[key] = value; return query; },
      order() { return query; },
      limit() { return query; },
      maybeSingle() {
        if (table === "players") {
          return Promise.resolve({
            data: { id: PLAYER_ID, external_id: "podplay-player", club_id: CLUB_ID },
            error: null,
          });
        }
        if (table === "attendances" && filters.event_id === TRIGGER_ID) {
          return Promise.resolve({ data: { attended_at: CUTOFF }, error: null });
        }
        if (table === "retention_sequences") return Promise.resolve({ data: state.sequence, error: null });
        if (table === "retention_candidates") return Promise.resolve({ data: state.stepOneCandidate, error: null });
        if (table === "messages") return Promise.resolve({ data: state.stepOneMessage, error: null });
        if (table === "clubs") {
          return Promise.resolve({
            data: {
              platform_subdomain: "test",
              platform_api_key: "offline-test-key",
              timezone: "America/New_York",
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: { message: `unexpected ${table} query` } });
      },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        if (table !== "attendances") {
          return Promise.resolve({ data: null, error: { message: `unexpected ${table} list` } }).then(resolve, reject);
        }
        return Promise.resolve({ data: state.attendanceRows, error: null }).then(resolve, reject);
      },
    };
    return query;
  };
}

function candidate(step: 1 | 2): RetentionCandidate {
  return {
    id: `candidate-step-${step}`,
    club_id: CLUB_ID,
    player_id: PLAYER_ID,
    playbook_key: "ltp_followup",
    trigger_event_id: TRIGGER_ID,
    status: "approved",
    message_id: `message-step-${step}`,
    created_at: "2026-09-04T12:00:00.000Z",
    updated_at: "2026-09-04T12:00:00.000Z",
    step,
    sequence_id: "sequence",
    sequence_status: "active",
    context: {
      variant: "with_program",
      trigger: { event_id: TRIGGER_ID, name: "Learn to Play", date: "2026-09-01" },
      player_first_name: "Sam",
      next_program: {
        event_id: EVENT_ID,
        name: "Beginner Session",
        start_time: OLD_START,
        date: "2026-10-04",
        time: "10:30 AM",
        signup_url: `https://test.podplay.app/community/events/${EVENT_ID}`,
        spots_remaining: 2,
      },
      classmates_signed_up: 0,
      already_booked: false,
      booked_event: null,
      promo: step === 1 ? { code: "LTPNEXT25", offer_text: "25% off your next program" } : null,
      coupon_warning: null,
      evaluated_at: "2026-09-04T12:00:00.000Z",
      ltp_text: {
        step,
        seed_nonce: 0,
        slot_indices: {},
        slot_templates: {},
        opener: "",
        ltp_date: "Sept 1",
        when: "Sunday, Oct 4 at 10:30am",
      },
    },
  };
}

function batchOptions() {
  const client = new RetentionPodplayBatchClient({
    minimumSpacingMs: 0,
    sleep: async () => {},
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      state.requests.push(url.pathname);
      if (url.pathname.endsWith(`/events/${TRIGGER_ID}`)) {
        return Response.json({
          item: {
            id: TRIGGER_ID,
            name: "Learn to Play",
            startTime: CUTOFF,
            status: "PUBLISHED",
            isCanceled: false,
          },
        });
      }
      if (url.pathname === "/apis/v2/events") return Response.json({ items: [] });
      if (url.pathname.endsWith(`/events/${EVENT_ID}/signups`)) {
        return Response.json({ items: state.signups });
      }
      if (url.pathname.endsWith(`/events/${EVENT_ID}`)) {
        if (url.search) return Response.json({ items: [] });
        return Response.json({ item: state.event });
      }
      if (url.pathname.endsWith("/coupons")) {
        return Response.json({
          items: [{
            code: "LTPNEXT25",
            active: true,
            discountType: "PERCENT_OFF",
            value: 25,
            eligibleType: "EVENT_CLASS",
            eligibleTypes: ["EVENT_CLASS"],
            eligibleEventIds: [],
          }],
        });
      }
      throw new Error(`Unexpected provider URL ${url.pathname}`);
    },
  });
  const clubCache = new Map([
    [CLUB_ID, Promise.resolve({
      base: "https://test.podplay.app",
      apiKey: "offline-test-key",
      timezone: "America/New_York",
    })],
  ]);
  return {
    client,
    clubCache,
    eventsCache: new Map<string, Promise<any[]>>(),
    signupsCache: new Map<string, Promise<any[]>>(),
  };
}

async function recheck(step: 1 | 2) {
  return recheckLtpSequenceDispatch(
    candidate(step),
    batchOptions(),
    step === 2 ? "Thanks for joining us." : "Thanks for joining us. LTPNEXT25",
  );
}

test("fresh direct suggested-event lookup permits an unchanged session for steps 1 and 2", async () => {
  for (const step of [1, 2] as const) {
    reset();
    const result = await recheck(step);
    assert.equal(result.valid, true);
    assert.equal(state.requests.filter((path) => path === `/apis/v2/events/${EVENT_ID}`).length, 1);
  }
});

test("fresh direct suggested-event lookup detects raw start-time changes for both steps", async () => {
  for (const step of [1, 2] as const) {
    reset({ event: { ...state.event, startTime: NEW_START } });
    const result = await recheck(step);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "session_changed");
    assert.deepEqual(result.sessionChange, {
      old_start_time: OLD_START,
      new_start_time: NEW_START,
      reason: "start_time_changed",
    });
  }
});

test("canceled and full suggested events return session-change reasons, while a booking exits as booked", async () => {
  reset({
    event: {
      id: EVENT_ID,
      name: "Beginner Session",
      startTime: OLD_START,
      status: "CANCELED",
      isCanceled: true,
      totalTeams: 2,
    },
  });
  const canceled = await recheck(1);
  assert.equal(canceled.reason, "session_changed");
  assert.equal(canceled.sessionChange?.reason, "canceled");
  assert.equal(canceled.sessionChange?.new_start_time, OLD_START);

  reset({
    signups: [
      { status: "CONFIRMED" },
      { status: "CONFIRMED" },
    ],
  });
  const full = await recheck(2);
  assert.equal(full.reason, "session_changed");
  assert.equal(full.sessionChange?.reason, "full");

  reset({
    attendanceRows: [{
      event_id: "newly-booked-event",
      attended_at: "2026-09-03T12:00:00.000Z",
    }],
  });
  const booked = await recheck(1);
  assert.equal(booked.reason, null);
  assert.deepEqual(booked.booked, {
    booked_event_id: "newly-booked-event",
    source: "attendances",
  });
  assert.equal(state.requests.some((path) => path === `/apis/v2/events/${EVENT_ID}`), false);
});

test("failed or malformed direct suggested-event lookups fail closed", async () => {
  reset({ event: { id: EVENT_ID, name: "Beginner Session", startTime: OLD_START } });
  await assert.rejects(recheck(1), /suggested-event lookup returned an incomplete or invalid event/);

  reset();
  const options = batchOptions();
  const originalFetch = options.client!.fetch;
  options.client!.fetch = async (input, init) => {
    if (String(input).endsWith(`/events/${EVENT_ID}`)) return new Response("unavailable", { status: 503 });
    return originalFetch(input, init);
  };
  await assert.rejects(
    recheckLtpSequenceDispatch(candidate(2), options, "Thanks for joining us."),
    /suggested-event lookup returned 503/,
  );
});

test("session-review diagnostics are added with a context-and-version CAS after the existing RPC reset", async () => {
  const oldContext = {
    reason: "session_changed",
    diagnostics: { provider_listing: { pages: 3 } },
    errors: ["Suggested session changed; rebuild context and re-review"],
  };
  const rpcCandidate = {
    id: "candidate",
    status: "drafted",
    updated_at: "2026-09-04T12:00:00.123456Z",
    context: oldContext,
  };
  let updateValues: any;
  let filters: Record<string, unknown> = {};
  (supabase as any).rpc = async (name: string, args: any) => {
    assert.equal(name, "retention_sequence_session_changed");
    assert.equal(args.p_expected_claimed_at, null);
    return { data: rpcCandidate, error: null };
  };
  (supabase as any).from = (table: string) => {
    assert.equal(table, "retention_candidates");
    const query: any = {
      update(values: any) { updateValues = values; return query; },
      eq(key: string, value: unknown) { filters[key] = value; return query; },
      select() { return query; },
      maybeSingle() {
        assert.equal(filters.id, "candidate");
        assert.equal(filters.status, "drafted");
        assert.equal(filters.updated_at, rpcCandidate.updated_at);
        assert.equal(filters.context, JSON.stringify(oldContext));
        return Promise.resolve({
          data: { id: "candidate", context: updateValues.context, updated_at: rpcCandidate.updated_at },
          error: null,
        });
      },
    };
    return query;
  };
  try {
    const sessionChange = {
      old_start_time: OLD_START,
      new_start_time: NEW_START,
      reason: "start_time_changed" as const,
    };
    const previousLtpText = {
      step: 2 as const,
      seed_nonce: 13,
      slot_indices: { opener: 1, nudge: 2, next_step: 0 },
      slot_templates: { opener: "Hello.", nudge: "A quick follow-up.", next_step: "{program} on {when}." },
      opener: "Hello.",
      ltp_date: "Sept 1",
      when: "Sunday, Oct 4 at 10:30am",
    };
    const updated = await returnLtpSequenceForSessionReview(
      CLUB_ID,
      "candidate",
      null,
      sessionChange,
      previousLtpText,
    ) as any;
    assert.deepEqual(updated.context.session_change, sessionChange);
    assert.deepEqual(updated.context.diagnostics, oldContext.diagnostics);
    assert.deepEqual(updated.context.errors, oldContext.errors);
    assert.deepEqual(updated.context.ltp_text, previousLtpText);
    assert.equal(updated.context.ltp_text.seed_nonce, 13);
    assert.equal(updated.status, "drafted");
  } finally {
    (supabase as any).rpc = originalRpc;
    (supabase as any).from = originalFrom;
  }
});

test("session-review metadata CAS does not overwrite a concurrent candidate change", async () => {
  (supabase as any).rpc = async () => ({
    data: {
      id: "candidate",
      status: "drafted",
      updated_at: "2026-09-04T12:00:00.123456Z",
      context: { reason: "session_changed" },
    },
    error: null,
  });
  (supabase as any).from = () => ({
    update() { return this; },
    eq() { return this; },
    select() { return this; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
  });
  try {
    await assert.rejects(
      returnLtpSequenceForSessionReview(CLUB_ID, "candidate", null, {
        old_start_time: OLD_START,
        new_start_time: NEW_START,
        reason: "start_time_changed",
      }),
      /without overwriting a concurrent edit/,
    );
  } finally {
    (supabase as any).rpc = originalRpc;
    (supabase as any).from = originalFrom;
  }
});

test("tests restore the shared Supabase methods", () => {
  (supabase as any).from = originalFrom;
  (supabase as any).rpc = originalRpc;
});
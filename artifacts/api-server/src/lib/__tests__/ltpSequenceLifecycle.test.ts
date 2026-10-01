import assert from "node:assert/strict";
import { test } from "node:test";
import { RetentionPodplayBatchClient } from "../retentionPodplayBatch.js";
import { supabase } from "../supabaseClient.js";
import {
  checkLtpBookingSince,
  confirmLtpRecipientDelivery,
  transitionLtpSequence,
  verifyLtpSequenceSchemaReady,
} from "../ltpSequenceLifecycle.js";

const originalFrom = (supabase as any).from;
const originalRpc = (supabase as any).rpc;
const CLUB_ID = "00000000-0000-4000-8000-000000000021";
const PLAYER_ID = "00000000-0000-4000-8000-000000000022";
const EVENT_ID = "00000000-0000-4000-8000-000000000023";
const CUTOFF = "2026-09-01T12:00:00.000Z";

let state: {
  player: any;
  playerError: any;
  attendanceRows: any[];
  attendanceError: any;
  requests: string[];
  requestUrls: string[];
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function reset(options: Partial<typeof state> = {}) {
  state = {
    player: { id: PLAYER_ID, external_id: "podplay-player", club_id: CLUB_ID },
    playerError: null,
    attendanceRows: [],
    attendanceError: null,
    requests: [],
    requestUrls: [],
    ...options,
  };
  (supabase as any).from = (table: string) => {
    let filters: Record<string, unknown> = {};
    const query: any = {
      select() { return query; },
      eq(key: string, value: unknown) { filters[key] = value; return query; },
      gt(key: string, value: unknown) { filters[key] = value; return query; },
      order() { return query; },
      limit() { return query; },
      maybeSingle() {
        if (table === "players") return Promise.resolve({ data: state.player, error: state.playerError });
        return Promise.resolve({ data: null, error: { message: `unexpected maybeSingle ${table}` } });
      },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        if (table !== "attendances") return Promise.resolve({ data: null, error: { message: `unexpected select ${table}` } }).then(resolve, reject);
        assert.equal(filters.player_id, PLAYER_ID);
        assert.equal(filters.attended_at, CUTOFF);
        return Promise.resolve({ data: state.attendanceRows, error: state.attendanceError }).then(resolve, reject);
      },
    };
    return query;
  };
}

function upcomingEvent(daysFromNow = 1) {
  return [{
    id: EVENT_ID,
    name: "A verified upcoming session",
    startTime: new Date(Date.now() + daysFromNow * 24 * 60 * 60_000).toISOString(),
    status: "PUBLISHED",
    isCanceled: false,
    totalTeams: 4,
  }];
}

function fixtureOptions(
  signupRows: any[],
  extra: {
    eventStatus?: number;
    listingPayload?: unknown;
    listingPages?: Map<number, unknown>;
    clubError?: boolean;
  } = {},
) {
  const client = new RetentionPodplayBatchClient({
    minimumSpacingMs: 0,
    sleep: async () => {},
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      state.requests.push(url.pathname);
      state.requestUrls.push(url.toString());
      if (url.pathname.endsWith("/events")) {
        const page = Number(url.searchParams.get("page") ?? "1");
        return response(
          extra.listingPages?.get(page) ?? extra.listingPayload ?? { items: upcomingEvent() },
          extra.eventStatus ?? 200,
        );
      }
      if (/\/events\/[^/]+\/signups$/.test(url.pathname)) return response({ items: signupRows });
      throw new Error("Test received an unexpected PodPlay request");
    },
  });
  const clubCache = new Map([
    [CLUB_ID, Promise.resolve({ base: "https://test.podplay.app", apiKey: "offline-test-key", timezone: "America/New_York" })],
  ]);
  if (extra.clubError) clubCache.set(CLUB_ID, Promise.reject(new Error("Club config unavailable")));
  return {
    client,
    clubCache,
    eventsCache: new Map<string, Promise<any[]>>(),
    signupsCache: new Map<string, Promise<any[]>>(),
  };
}

test("attendance history is checked first and records its actual event ID", async () => {
  reset({ attendanceRows: [{ event_id: "attendance-event", attended_at: "2026-09-03T15:00:00.000Z" }] });
  const options = fixtureOptions([]);
  const booked = await checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, options);
  assert.deepEqual(booked, { booked_event_id: "attendance-event", source: "attendances" });
  assert.deepEqual(state.requests, []);
});

test("an active live upcoming signup blocks dispatch for the exact player", async () => {
  reset();
  const options = fixtureOptions([{
    status: "CONFIRMED",
    owner: { id: "podplay-player" },
  }]);
  const booked = await checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, options);
  assert.deepEqual(booked, { booked_event_id: EVENT_ID, source: "podplay_upcoming_signup" });
  assert.equal(state.requests.filter((path) => path.endsWith("/events")).length, 1);
  assert.equal(state.requests.filter((path) => path.endsWith("/signups")).length, 1);
});

test("a live signup more than fourteen days away still blocks dispatch", async () => {
  reset();
  const options = fixtureOptions([{
    status: "CONFIRMED",
    owner: { id: "podplay-player" },
  }], {
    listingPayload: { items: upcomingEvent(35) },
  });
  assert.deepEqual(await checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, options), {
    booked_event_id: EVENT_ID, source: "podplay_upcoming_signup",
  });
  const listingUrl = new URL(state.requestUrls.find((url) => new URL(url).pathname.endsWith("/events"))!);
  assert.equal(listingUrl.searchParams.get("endTime"), "9999-12-31T23:59:59.999Z");
});

test("all-future booking lookup paginates through to a later booked session", async () => {
  reset();
  const firstPage = Array.from({ length: 500 }, (_, index) => ({
    id: `draft-${index}`,
    name: "Draft session",
    startTime: new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString(),
    status: "DRAFT",
    isCanceled: false,
  }));
  const later = { ...upcomingEvent(35)[0], id: "booked-35-days" };
  const options = fixtureOptions([{
    status: "CONFIRMED",
    owner: { id: "podplay-player" },
  }], {
    listingPages: new Map([
      [1, { items: firstPage, totalPages: 2, hasMore: true }],
      [2, { items: [later], totalPages: 2, hasMore: false }],
    ]),
  });
  assert.deepEqual(await checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, options), {
    booked_event_id: "booked-35-days", source: "podplay_upcoming_signup",
  });
  assert.equal(state.requestUrls.filter((url) => new URL(url).pathname.endsWith("/events")).length, 2);
  assert.equal(state.requestUrls.filter((url) => new URL(url).pathname.endsWith("/signups")).length, 1);
});

test("all-future booking listing fails closed when pagination reaches its safety cap", async () => {
  reset();
  const options = fixtureOptions([], {
    listingPayload: { items: [], hasMore: true },
  });
  await assert.rejects(
    checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, options),
    /exceeded the pagination safety limit/,
  );
  assert.equal(state.requestUrls.filter((url) => new URL(url).pathname.endsWith("/events")).length, 100);
});

test("all-future booking events and signup pages are shared across a cohort", async () => {
  reset();
  const options = fixtureOptions([]);
  assert.equal(await checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, options), null);
  const initialRequests = state.requestUrls.length;
  assert.equal(await checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, options), null);
  assert.equal(state.requestUrls.length, initialRequests);
});

test("canceled, draft, and other players' signups are not attributed to this player", async () => {
  reset();
  const options = fixtureOptions([
    { status: "CANCELED", owner: { id: "podplay-player" } },
    { status: "DRAFT", owner: { id: "podplay-player" } },
    { status: "CONFIRMED", owner: { id: "someone-else" } },
  ]);
  assert.equal(await checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, options), null);
  assert.equal(state.requests.filter((path) => path.endsWith("/signups")).length, 1);
});

test("any other active signup status is conservatively treated as a booking", async () => {
  reset();
  const options = fixtureOptions([{
    status: "WAITLISTED",
    owner: { id: "podplay-player" },
  }]);
  assert.deepEqual(await checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, options), {
    booked_event_id: EVENT_ID, source: "podplay_upcoming_signup",
  });
});

test("an invalid cutoff fails closed before database and provider lookup", async () => {
  reset();
  await assert.rejects(checkLtpBookingSince(CLUB_ID, PLAYER_ID, "not-a-date"), /cutoff is missing or invalid/);
  assert.deepEqual(state.requests, []);
});

test("missing external PodPlay identity does not silently approve dispatch", async () => {
  reset({ player: { id: PLAYER_ID, external_id: null, club_id: CLUB_ID } });
  const options = fixtureOptions([]);
  await assert.rejects(checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, options), /no verified PodPlay external ID/);
  assert.deepEqual(state.requests, []);
});

test("database attendance read errors and provider HTTP errors fail closed", async () => {
  reset({ attendanceError: { message: "offline attendance read" } });
  const attendanceOptions = fixtureOptions([]);
  await assert.rejects(checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, attendanceOptions), /attendance-history lookup failed/);
  assert.deepEqual(state.requests, []);

  reset();
  const providerOptions = fixtureOptions([], { eventStatus: 429 });
  await assert.rejects(checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, providerOptions), /event listing returned 429/);
});

test("invalid event-list payloads fail closed rather than implying no bookings", async () => {
  reset();
  const options = fixtureOptions([], { listingPayload: { items: [{ id: EVENT_ID }] } });
  await assert.rejects(checkLtpBookingSince(CLUB_ID, PLAYER_ID, CUTOFF, options), /contains an invalid event/);
});

test("migration 013 readiness check rejects an absent or incomplete sequence schema", async () => {
  (supabase as any).rpc = async () => ({ data: false, error: null });
  try {
    await assert.rejects(verifyLtpSequenceSchemaReady(), /migration 013 is not installed or ready/);
  } finally {
    (supabase as any).rpc = originalRpc;
  }
});

test("booked-exit RPC requires a provider-backed booking event ID", async () => {
  let calls = 0;
  (supabase as any).rpc = async (_name: string, args: any) => {
    calls++;
    return { data: args, error: null };
  };
  try {
    await assert.rejects(
      transitionLtpSequence(CLUB_ID, PLAYER_ID, "ltp_followup", "exited_booked", "booking found"),
      /booked event ID is required/,
    );
    assert.equal(calls, 0);
    const result = await transitionLtpSequence(
      CLUB_ID, PLAYER_ID, "ltp_followup", "exited_booked", "booking found", EVENT_ID,
    );
    assert.equal((result as any).p_status, "exited_booked");
    assert.equal((result as any).p_booked_event_id, EVENT_ID);
    assert.equal(calls, 1);
  } finally {
    (supabase as any).rpc = originalRpc;
  }
});

test("redirected and unconfirmed messages cannot begin the real-delivery clock", async () => {
  const originalRpc = (supabase as any).rpc;
  let message: any = { status: "sent", delivery_status: "delivered", delivered_at: "2026-09-10T10:00:00.000Z", retention_delivery_kind: "test" };
  let ledger: any = { is_test: true, player_id: null, intended_player_id: PLAYER_ID };
  let rpcCalls = 0;
  (supabase as any).from = (table: string) => {
    let operation = "select";
    let next: any;
    const query: any = {
      select() { return query; },
      update(values: any) { operation = "update"; next = values; return query; },
      eq() { return query; },
      is() { return query; },
      limit() { return query; },
      maybeSingle() {
        if (table === "retention_candidates") return Promise.resolve({ data: { playbook_key: "ltp_followup", club_id: CLUB_ID, player_id: PLAYER_ID }, error: null });
        if (table === "messages" && operation === "select") return Promise.resolve({ data: message, error: null });
        if (table === "contact_ledger") return Promise.resolve({ data: ledger, error: null });
        if (table === "messages" && operation === "update") {
          message = { ...message, ...next };
          return Promise.resolve({ data: { id: "message" }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    return query;
  };
  (supabase as any).rpc = async () => { rpcCalls++; return { data: {}, error: null }; };
  try {
    assert.equal(await confirmLtpRecipientDelivery("message"), false);
    assert.equal(message.retention_delivery_kind, "test");
    assert.equal(rpcCalls, 0);

    message = { status: "sent", delivery_status: "sent", delivered_at: null, retention_delivery_kind: null };
    ledger = { is_test: false, player_id: PLAYER_ID, intended_player_id: PLAYER_ID };
    assert.equal(await confirmLtpRecipientDelivery("message"), false);
    assert.equal(message.retention_delivery_kind, null);
    assert.equal(rpcCalls, 0);
  } finally {
    (supabase as any).rpc = originalRpc;
    (supabase as any).from = originalFrom;
  }
});

test("only a confirmed real-recipient delivery is persisted and recorded in the sequence", async () => {
  const originalRpc = (supabase as any).rpc;
  let message: any = { status: "sent", delivery_status: "delivered", delivered_at: "2026-09-10T10:00:00.000Z", retention_delivery_kind: null };
  let rpcArgs: any = null;
  (supabase as any).from = (table: string) => {
    let operation = "select";
    let next: any;
    const query: any = {
      select() { return query; },
      update(values: any) { operation = "update"; next = values; return query; },
      eq() { return query; },
      is() { return query; },
      limit() { return query; },
      maybeSingle() {
        if (table === "retention_candidates") return Promise.resolve({ data: { playbook_key: "ltp_followup", club_id: CLUB_ID, player_id: PLAYER_ID }, error: null });
        if (table === "messages" && operation === "select") return Promise.resolve({ data: message, error: null });
        if (table === "contact_ledger") return Promise.resolve({ data: { is_test: false, player_id: PLAYER_ID, intended_player_id: PLAYER_ID }, error: null });
        if (table === "messages" && operation === "update") {
          message = { ...message, ...next };
          return Promise.resolve({ data: { id: "message" }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    return query;
  };
  (supabase as any).rpc = async (name: string, args: any) => {
    rpcArgs = { name, args };
    return { data: { step1_sent_at: message.delivered_at }, error: null };
  };
  try {
    assert.equal(await confirmLtpRecipientDelivery("message"), true);
    assert.equal(message.retention_delivery_kind, "real");
    assert.equal(rpcArgs.name, "retention_sequence_record_send");
    assert.deepEqual(rpcArgs.args, {
      p_club_id: CLUB_ID,
      p_message_id: "message",
      p_delivery_kind: "real",
    });
  } finally {
    (supabase as any).rpc = originalRpc;
    (supabase as any).from = originalFrom;
  }
});

test("test suite restores the global Supabase client methods", () => {
  (supabase as any).from = originalFrom;
  (supabase as any).rpc = originalRpc;
});
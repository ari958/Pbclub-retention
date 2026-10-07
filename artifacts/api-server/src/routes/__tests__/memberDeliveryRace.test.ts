import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import twilio from "twilio";
import { supabase } from "../../lib/supabaseClient";
import { validateTwilioWebhook } from "../../lib/twilioWebhook";
import { sendViaTwilio, setTwilioClientFactoryForTests, setTwilioClockForTests,
  setLtpSequenceBatchOptionsFactoryForTests } from "../../lib/twilio";
import { OPERATOR_TEST_TEXT, sendOperatorTestMessage } from "../../lib/operatorTestMessage";
import messagesRouter from "../messages";

const id = "00000000-0000-4000-8000-000000000001";
const playerId = "00000000-0000-4000-8000-000000000002";
const clubId = "00000000-0000-4000-8000-000000000003";
const sid = `SM${"a".repeat(32)}`;
const at = "2026-10-07T16:00:00.000Z";
const body = "Thanks for coming by!";
const originalFrom = supabase.from, originalRpc = supabase.rpc;
const envKeys = ["NODE_ENV", "SMS_LIVE", "SMS_TEST_OVERRIDE_TO", "RETENTION_ONLY_MODE",
  "PUBLIC_API_URL", "TWILIO_AUTH_TOKEN", "ALERT_OPERATOR_TO"] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let rows: Record<string, any[]>, calls: any[], rpcCalls: any[];
let providerHook: ((options: any) => Promise<void>) | undefined;
let providerStatus = "queued", failReceiptWrite = false, failLedger = false;

// Isolated, filter-aware REST fixture. All provider calls and database writes
// stay in memory, including sequence milestones.
function queryFor(table: string) {
  let action = "select", payload: any, single = false;
  const filters: Array<(row: any) => boolean> = [];
  const matches = (row: any, clause: string): boolean => {
    const [key, op, ...parts] = clause.split(".");
    const value = parts.join(".");
    if (op === "is") return value === "null" && row[key] == null;
    if (op === "not") return value === "is.null" && row[key] != null;
    if (op === "eq") return String(row[key]) === value;
    throw new Error(`Unhandled fixture OR: ${clause}`);
  };
  const q: any = {
    select() { return q; },
    insert(value: any) { action = "insert"; payload = value; return q; },
    update(value: any) { action = "update"; payload = value; return q; },
    eq(key: string, value: any) { filters.push(row => row[key] === value); return q; },
    is(key: string, value: any) { filters.push(row => value === null ? row[key] == null : row[key] === value); return q; },
    not(key: string, op: string, value: any) {
      assert.equal(op, "is"); assert.equal(value, null);
      filters.push(row => row[key] != null); return q;
    },
    or(value: string) { filters.push(row => value.split(",").some(clause => matches(row, clause))); return q; },
    gt(key: string, value: any) { filters.push(row => row[key] > value); return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle() { single = true; return Promise.resolve(resolve()); },
    then(yes: any, no: any) { return Promise.resolve(resolve()).then(yes, no); },
  };
  function resolve() {
    if ((table === "messages" && action === "update" && payload.delivery_status && failReceiptWrite)
      || (table === "contact_ledger" && action === "insert" && failLedger)) {
      return { data: null, error: { message: "fixture database unavailable" } };
    }
    const data = rows[table] ?? [];
    if (action === "insert") data.push({ ...payload });
    const affected = data.filter(row => filters.every(filter => filter(row)));
    if (action === "update") affected.forEach(row => Object.assign(row, payload));
    return { data: single ? affected[0] ?? null : affected, error: null };
  }
  return q;
}
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
app.use(validateTwilioWebhook);
app.use("/api", messagesRouter);
let server: ReturnType<typeof app.listen>, base: string;

async function callback(url: string, status: string, options: {
  invalid?: boolean; signedUrl?: string; errorCode?: string; messageSid?: string;
} = {}) {
  const params = { MessageSid: options.messageSid ?? sid, MessageStatus: status,
    ...(options.errorCode ? { ErrorCode: options.errorCode, ErrorMessage: "fixture failure" } : {}) };
  const signature = options.invalid ? "invalid" : twilio.getExpectedTwilioSignature(
    "fixture-token", options.signedUrl ?? url, params);
  const target = new URL(url);
  return fetch(`${base}${target.pathname}${target.search}`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
    body: new URLSearchParams(params) });
}
const send = () => sendViaTwilio(rows.players[0].phone, body, { messageId: id });
const message = () => rows.messages[0];
const realMilestones = () => rpcCalls.filter(call =>
  call.name === "retention_sequence_record_send" && call.args.p_delivery_kind === "real");
function useSequence() {
  rows.retention_candidates[0] = { ...rows.retention_candidates[0],
    playbook_key: "ltp_followup", step: 2, sequence_id: "sequence", sequence_status: "active",
    context: { variant: "no_program", ltp_text: { step: 2 }, promo: null } };
  rows.retention_candidates.push({ id: "step-one", step: 1, sequence_id: "sequence",
    club_id: clubId, message_id: "step-one-message" });
  rows.messages.push({ id: "step-one-message", status: "sent", sent_at: "2026-10-05T16:00:00Z",
    simulated: false, retention_delivery_kind: "real" });
  rows.retention_sequences = [{ id: "sequence", club_id: clubId, sequence_status: "active",
    step1_sent_at: "2026-10-05T16:00:00Z", step1_delivery_kind: "real" }];
}

before(async () => {
  process.env.NODE_ENV = "test";
  (supabase as any).from = queryFor;
  (supabase as any).rpc = async (name: string, args: any) => {
    rpcCalls.push({ name, args });
    if (name === "retention_sequence_claim") {
      if (message().dispatch_claimed_at || message().status !== "pending"
        || rows.retention_candidates[0].status !== "approved") return { data: null, error: null };
      message().dispatch_claimed_at = args.p_claimed_at;
    }
    return { data: name === "retention_sequence_ready" ? true : { sequence_status: "active" }, error: null };
  };
  setTwilioClientFactoryForTests(() => ({ messages: { create: async (options: any) => {
    calls.push(options);
    await providerHook?.(options);
    return { sid, status: providerStatus };
  } } } as any));
  setTwilioClockForTests(() => new Date(at));
  setLtpSequenceBatchOptionsFactoryForTests(() => ({ bookingSnapshot: {
    clubId, capturedAt: Date.now(), completedAt: Date.now(), eventCount: 0, bookings: new Map(),
  } }));
  await new Promise<void>(resolve => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`; resolve();
    });
  });
});
beforeEach(() => {
  process.env.SMS_LIVE = "true"; process.env.RETENTION_ONLY_MODE = "true";
  process.env.PUBLIC_API_URL = "https://fixture.example"; process.env.TWILIO_AUTH_TOKEN = "fixture-token";
  delete process.env.SMS_TEST_OVERRIDE_TO; delete process.env.ALERT_OPERATOR_TO;
  rows = {
    messages: [{ id, body, approved_body: body, approved_at: at, approved_by: "fixture-operator",
      status: "pending", player_id: playerId, conversation_id: null, dispatch_token: null,
      dispatch_claimed_at: null, twilio_message_sid: null, delivery_status: null,
      delivered_at: null, sent_at: null, retention_delivery_kind: null }],
    players: [{ id: playerId, club_id: clubId, phone: "+15551234567", opted_out: false,
      external_id: "fixture-player" }],
    clubs: [{ id: clubId, sms_kill_switch: false }],
    retention_candidates: [{ id: "candidate", message_id: id, player_id: playerId,
      club_id: clubId, status: "approved", context: null }],
    contact_ledger: [], attendances: [], retention_ltp_test_controls: [],
  };
  calls = []; rpcCalls = []; providerHook = undefined; providerStatus = "queued";
  failReceiptWrite = false; failLedger = false;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  setTwilioClientFactoryForTests(null); setTwilioClockForTests(null);
  setLtpSequenceBatchOptionsFactoryForTests(null);
  (supabase as any).from = originalFrom; (supabase as any).rpc = originalRpc;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
});

for (const sequence of [false, true]) {
  for (const status of ["queued", "delivered", "failed", "undelivered"]) {
    test(`early ${status} receipt survives queued provider response (${sequence ? "sequence" : "token"} claim)`, async () => {
      if (sequence) useSequence();
      providerHook = async options => {
        const url = new URL(options.statusCallback);
        assert.equal(url.searchParams.get("member_message_id"), id);
        assert.equal(url.searchParams.get("dispatch_claimed_at"), at);
        assert.equal(url.searchParams.has("dispatch_token"), !sequence);
        assert.equal(message().twilio_message_sid, null);
        const response = await callback(options.statusCallback, status, {
          ...(status === "undelivered" ? { errorCode: "21610" } : {}),
        });
        assert.equal(response.status, 204);
        assert.equal(message().twilio_message_sid, sid);
        assert.equal(realMilestones().length, 0, "a receipt before acceptance/ledger is not a real milestone");
      };
      await send();
      assert.equal(message().delivery_status, status);
      assert.equal(message().status, ["failed", "undelivered"].includes(status) ? status : "sent");
      assert.equal(message().sent_at, at);
      assert.equal(rows.contact_ledger.length, 1);
      assert.equal(realMilestones().length, sequence && status === "delivered" ? 1 : 0);
      if (status === "undelivered") assert.equal(rows.players[0].opted_out, true);
      await assert.rejects(send(), /not explicitly approved/);
      assert.equal(calls.length, 1);
    });
  }
}
test("callback after provider response and duplicate receipts remain idempotent", async () => {
  useSequence(); await send();
  assert.equal(message().delivery_status, "queued"); assert.equal(realMilestones().length, 0);
  for (let i = 0; i < 2; i++) assert.equal((await callback(calls[0].statusCallback, "delivered")).status, 204);
  assert.equal(message().retention_delivery_kind, "real");
  assert.equal(calls.length, 1); assert.equal(rows.contact_ledger.length, 1);
  assert.ok(realMilestones().every(call => call.args.p_message_id === id));
});
test("a concurrent caller cannot submit the same approved message twice", async () => {
  providerHook = async () => {
    await assert.rejects(send(), /not explicitly approved/);
  };
  await send(); assert.equal(calls.length, 1); assert.equal(rows.contact_ledger.length, 1);
});
test("a delivered provider response cannot replace an early failed receipt or create a real milestone", async () => {
  useSequence(); providerStatus = "delivered";
  providerHook = async options => {
    assert.equal((await callback(options.statusCallback, "failed", { errorCode: "30003" })).status, 204);
  };
  await send(); assert.equal(message().delivery_status, "failed"); assert.equal(message().status, "failed");
  assert.equal(message().error_code, "30003"); assert.equal(message().delivered_at, null);
  assert.equal(realMilestones().length, 0);
});
test("a delivered provider response without a callback records verified real delivery", async () => {
  useSequence(); providerStatus = "delivered"; await send();
  assert.equal(message().delivery_status, "delivered");
  assert.equal(message().retention_delivery_kind, "real"); assert.equal(realMilestones().length, 1);
});
test("a signed stale claim cannot update a known SID or opt out its player", async () => {
  await send();
  const stale = new URL(calls[0].statusCallback);
  stale.searchParams.set("dispatch_token", "00000000-0000-4000-8000-000000000099");
  assert.equal((await callback(stale.href, "undelivered", { errorCode: "21610" })).status, 500);
  assert.equal(message().delivery_status, "queued"); assert.equal(rows.players[0].opted_out, false);
});
test("a claim already bound to a different SID is not rebound or resent", async () => {
  providerHook = async options => {
    const otherSid = `SM${"b".repeat(32)}`;
    assert.equal((await callback(options.statusCallback, "queued", { messageSid: otherSid })).status, 204);
  };
  await assert.rejects(send(), /message bookkeeping failed/);
  assert.equal(message().twilio_message_sid, `SM${"b".repeat(32)}`);
  await assert.rejects(send(), /not explicitly approved/); assert.equal(calls.length, 1);
});
test("invalid signature and tampered query cannot bind a SID or write delivery evidence", async () => {
  providerHook = async options => {
    assert.equal((await callback(options.statusCallback, "delivered", { invalid: true })).status, 403);
    const tampered = new URL(options.statusCallback);
    tampered.searchParams.set("dispatch_token", "00000000-0000-4000-8000-000000000099");
    assert.equal((await callback(tampered.href, "delivered", { signedUrl: options.statusCallback })).status, 403);
    assert.equal(message().twilio_message_sid, null); assert.equal(message().delivered_at, null);
  };
  await send(); assert.equal(message().delivery_status, "queued");
});
test("signed wrong, unclaimed, unapproved, or playerless correlation cannot claim a message", async () => {
  const url = new URL("https://fixture.example/api/messages/webhook/status");
  url.searchParams.set("member_message_id", id); url.searchParams.set("dispatch_claimed_at", at);
  url.searchParams.set("dispatch_token", "00000000-0000-4000-8000-000000000009");
  for (const patch of [
    {}, { dispatch_claimed_at: at, dispatch_token: "wrong" },
    { dispatch_claimed_at: at, dispatch_token: url.searchParams.get("dispatch_token"), approved_at: null },
    { approved_at: at, player_id: null },
  ]) {
    Object.assign(message(), patch);
    assert.equal((await callback(url.href, "delivered")).status, 503);
    assert.equal(message().twilio_message_sid, null); assert.equal(realMilestones().length, 0);
  }
});
test("early receipt database failure requests retry, then saves by persisted SID", async () => {
  providerHook = async options => {
    failReceiptWrite = true;
    assert.equal((await callback(options.statusCallback, "delivered")).status, 503);
    failReceiptWrite = false;
  };
  await send();
  assert.equal((await callback(calls[0].statusCallback, "delivered")).status, 204);
  assert.equal(message().delivery_status, "delivered");
});
test("redirected member delivery never records a real sequence milestone", async () => {
  useSequence(); process.env.SMS_TEST_OVERRIDE_TO = "+15557654321";
  providerHook = async options => {
    assert.equal(options.to, process.env.SMS_TEST_OVERRIDE_TO);
    assert.equal(message().retention_delivery_kind, "test");
    assert.equal((await callback(options.statusCallback, "delivered")).status, 204);
  };
  await send();
  assert.equal(message().delivery_status, "delivered"); assert.equal(message().retention_delivery_kind, "test");
  assert.equal(rows.contact_ledger[0].is_test, true); assert.equal(rows.contact_ledger[0].player_id, null);
  assert.equal(realMilestones().length, 0);
});
test("missing approvals, candidate, inactive sequence, or opted-out player block transport", async () => {
  for (const mutate of [
    () => { message().approved_at = null; },
    () => { rows.retention_candidates = []; },
    () => { useSequence(); rows.retention_candidates[0].sequence_status = "completed"; },
    () => { rows.players[0].opted_out = true; },
  ]) {
    const saved = structuredClone(rows);
    mutate(); await assert.rejects(send()); assert.equal(calls.length, 0); rows = saved;
  }
});
test("receipt plus failed acceptance bookkeeping retains claim and cannot trigger a second send", async () => {
  useSequence(); providerHook = async options => {
    assert.equal((await callback(options.statusCallback, "delivered")).status, 204);
    failLedger = true;
  };
  await assert.rejects(send(), /contact ledger write failed/);
  assert.equal(message().delivery_status, "delivered"); assert.ok(message().dispatch_claimed_at);
  assert.equal(realMilestones().length, 0);
  await assert.rejects(send(), /not explicitly approved/); assert.equal(calls.length, 1);
});
test("operator-test signed fallback still preserves early receipts without player milestones", async () => {
  rows.messages = []; rows.retention_candidates = []; process.env.SMS_TEST_OVERRIDE_TO = "+15557654321";
  providerHook = async options => {
    assert.equal(options.body, OPERATOR_TEST_TEXT);
    assert.ok(new URL(options.statusCallback).searchParams.get("operator_test_id"));
    assert.equal((await callback(options.statusCallback, "delivered")).status, 204);
  };
  await sendOperatorTestMessage(clubId, "fixture-operator");
  assert.equal(message().delivery_status, "delivered"); assert.equal(message().retention_delivery_kind, "test");
  assert.equal(message().player_id, null); assert.equal(realMilestones().length, 0);
});

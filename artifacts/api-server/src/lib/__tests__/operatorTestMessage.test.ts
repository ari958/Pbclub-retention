import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { supabase } from "../supabaseClient";
import {
  getOperatorTestMessages, OPERATOR_TEST_TABLE, OPERATOR_TEST_TEXT, recordOperatorTestReceipt, sendOperatorTestMessage,
} from "../operatorTestMessage";
import { setTwilioClientFactoryForTests, setTwilioClockForTests } from "../twilio";
import { assertRetentionDraftFresh } from "../retentionFreshness";

const original = { from: supabase.from, env: { ...process.env } };
process.env.NODE_ENV = "test";
// messages and contact_ledger are tracked only to prove operator tests never touch them.
let tests: any[] = [], messages: any[] = [], ledger: any[] = [], calls: any[] = [];
let kill = false, failRecord = false, failProvider = false, pauseAfterRecord = false, earlyReceipt = false;
(supabase as any).from = (table: string) => {
  let action = "", payload: any, single = false;
  const filters: Record<string, any> = {};
  const q: any = new Proxy({}, { get(_target, key) {
    const result = () => {
      if (table === "clubs") return { data: { sms_kill_switch: kill }, error: null };
      let rows = table === OPERATOR_TEST_TABLE ? tests : table === "messages" ? messages : table === "contact_ledger" ? ledger : [];
      if (action === "insert") {
        if (table === OPERATOR_TEST_TABLE && failRecord) return { data: null, error: { message: "offline table" } };
        rows.push({ ...payload, created_at: new Date().toISOString() });
        if (table === OPERATOR_TEST_TABLE && pauseAfterRecord) kill = true;
      }
      rows = rows.filter(row => Object.entries(filters).every(([k, v]) =>
        Array.isArray(v) ? v.includes(row[k]) : v === null ? row[k] == null : row[k] === v));
      if (action === "update") rows.forEach(row => Object.assign(row, payload));
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    if (key === "then") return (yes: any, no: any) => Promise.resolve(result()).then(yes, no);
    if (key === "insert" || key === "update") return (value: any) => { action = String(key); payload = value; return q; };
    if (key === "eq" || key === "in" || key === "is") return (name: string, value: any) => { filters[name] = value; return q; };
    if (key === "maybeSingle") return () => { single = true; return Promise.resolve(result()); };
    return () => q;
  } });
  return q;
};
setTwilioClientFactoryForTests(() => ({ messages: { create: async (options: any) => {
  calls.push(options);
  if (earlyReceipt) tests.at(-1).delivery_status = "delivered";
  if (failProvider) throw new Error("Ambiguous provider failure");
  return { sid: "SMoffline-fixture", status: "queued" };
} } } as any));
beforeEach(() => {
  tests = []; messages = []; ledger = []; calls = [];
  kill = false; failRecord = false; failProvider = false; pauseAfterRecord = false; earlyReceipt = false;
  process.env.SMS_LIVE = "true"; process.env.SMS_TEST_OVERRIDE_TO = "+15551234567";
  process.env.PUBLIC_API_URL = "https://operator.example";
  setTwilioClockForTests(() => new Date("2026-10-07T16:00:00Z"));
});
const writes = () => tests.length + messages.length + ledger.length + calls.length;
test("unset override refuses before DB writes or transport", async () => {
  delete process.env.SMS_TEST_OVERRIDE_TO;
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /OVERRIDE/);
  assert.equal(writes(), 0);
});
test("kill switch and live-off block without creating an approval or send", async () => {
  kill = true;
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /kill switch/);
  kill = false; process.env.SMS_LIVE = "false";
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /Live sending/);
  assert.equal(writes(), 0);
});
test("send window blocks operator tests", async () => {
  setTwilioClockForTests(() => new Date("2026-10-07T06:00:00Z"));
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /window/);
  assert.equal(calls.length, 0);
});
test("kill switch is checked again immediately before provider submission", async () => {
  pauseAfterRecord = true;
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /kill switch/);
  assert.equal(calls.length, 0);
  assert.equal(tests[0].status, "failed");
});
test("fixed override transport records actor, SID and refreshed receipt only in operator_test_messages", async () => {
  const result = await sendOperatorTestMessage("club", "operator:fixture");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "+15551234567");
  assert.equal(calls[0].body, OPERATOR_TEST_TEXT);
  assert.equal(new URL(calls[0].statusCallback).pathname, "/api/messages/webhook/status");
  assert.equal(new URL(calls[0].statusCallback).searchParams.get("operator_test_id"), result.message_id);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].club_id, "club");
  assert.equal(tests[0].actor, "operator:fixture");
  assert.equal(tests[0].status, "sent");
  assert.equal(tests[0].twilio_message_sid, "SMoffline-fixture");
  assert.equal(messages.length + ledger.length, 0, "no player message or contact ledger row");
  assert.equal(result.twilio_sid, "SMoffline-fixture");
  assert.equal(result.delivery_status, "queued");
  tests[0].delivery_status = "delivered"; // persisted status callback result
  assert.equal((await getOperatorTestMessages("club"))[0].delivery_status, "delivered");
});
test("an early delivery receipt is not overwritten by the provider's queued response", async () => {
  earlyReceipt = true;
  await sendOperatorTestMessage("club", "operator:fixture");
  assert.equal((await getOperatorTestMessages("club"))[0].delivery_status, "delivered");
});
test("record failure prevents transport; provider failure keeps an audited failure", async () => {
  failRecord = true;
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /migration 030/);
  assert.equal(calls.length, 0);
  failRecord = false; failProvider = true;
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /provider/);
  assert.equal(calls.length, 1);
  assert.equal(tests.at(-1).status, "failed");
  assert.match(tests.at(-1).error_message, /Ambiguous provider failure/);
});
test("receipts bind an unset SID once and never move to a different SID", async () => {
  tests = [{ id: "t1", club_id: "club", status: "sent", twilio_message_sid: null, delivery_status: null }];
  assert.deepEqual(await recordOperatorTestReceipt("t1", "SMfirst", "delivered"), { matched: true, error: null });
  assert.equal(tests[0].twilio_message_sid, "SMfirst");
  assert.equal(tests[0].delivery_status, "delivered");
  assert.ok(tests[0].delivered_at);
  assert.deepEqual(await recordOperatorTestReceipt("t1", "SMother", "failed"), { matched: false, error: null });
  assert.equal(tests[0].twilio_message_sid, "SMfirst");
  assert.equal(tests[0].status, "sent");
});
test("failed receipts mark the test failed with Twilio's error", async () => {
  tests = [{ id: "t1", club_id: "club", status: "sent", twilio_message_sid: "SMx", delivery_status: "queued" }];
  await recordOperatorTestReceipt("t1", "SMx", "undelivered", "30034", "Unregistered number");
  assert.equal(tests[0].status, "failed");
  assert.equal(tests[0].delivery_status, "undelivered");
  assert.equal(tests[0].error_code, "30034");
  assert.equal(tests[0].error_message, "Unregistered number");
});
test("production freshness blocks stale drafts and expires them at five days", () => {
  const now = new Date("2026-10-07T16:00:00Z");
  assert.throws(() => assertRetentionDraftFresh({ context: { stale: true } }, now), /Stale/);
  assert.throws(() => assertRetentionDraftFresh({ context: { lookback_days: 14 } }, now), /Stale/);
  assert.throws(() => assertRetentionDraftFresh({ created_at: "2026-10-02T16:00:00Z" }, now), /expired/);
  assert.doesNotThrow(() => assertRetentionDraftFresh({ created_at: "2026-10-02T16:00:01Z", context: { lookback_days: 3 } }, now));
  assert.doesNotThrow(() => assertRetentionDraftFresh({
    created_at: "2026-01-01T16:00:00Z", context: { lookback_days: 3, draft_generated_at: "2026-10-07T16:00:00Z" },
  }, now), "fresh regenerated context renews expiry; candidate edit/status timestamps do not");
});
after(() => {
  setTwilioClientFactoryForTests(null); setTwilioClockForTests(null);
  (supabase as any).from = original.from;
  for (const key of ["NODE_ENV", "SMS_LIVE", "SMS_TEST_OVERRIDE_TO", "PUBLIC_API_URL"]) {
    if (original.env[key] === undefined) delete process.env[key]; else process.env[key] = original.env[key];
  }
});

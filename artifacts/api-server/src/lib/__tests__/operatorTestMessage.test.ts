import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { supabase } from "../supabaseClient";
import { getOperatorTestMessages, OPERATOR_TEST_TEXT, sendOperatorTestMessage } from "../operatorTestMessage";
import { setTwilioClientFactoryForTests, setTwilioClockForTests } from "../twilio";
import { assertRetentionDraftFresh } from "../retentionFreshness";

const original = { from: supabase.from, env: { ...process.env } };
process.env.NODE_ENV = "test";
let messages: any[] = [], ledger: any[] = [], calls: any[] = [];
let kill = false, failLedger = false, failProvider = false, pauseAfterLedger = false, earlyReceipt = false;
(supabase as any).from = (table: string) => {
  let action = "", payload: any, single = false;
  const filters: Record<string, any> = {};
  const q: any = new Proxy({}, { get(_target, key) {
    const result = () => {
      if (table === "clubs") return { data: { sms_kill_switch: kill }, error: null };
      let rows = table === "messages" ? messages : table === "contact_ledger" ? ledger : [];
      if (action === "insert") {
        if (table === "contact_ledger" && failLedger) return { data: null, error: { message: "offline ledger" } };
        rows.push({ ...payload, created_at: new Date().toISOString() });
        if (table === "contact_ledger" && pauseAfterLedger) kill = true;
      }
      rows = rows.filter(row => Object.entries(filters).every(([k, v]) => Array.isArray(v) ? v.includes(row[k]) : row[k] === v));
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
  if (earlyReceipt) messages.at(-1).delivery_status = "delivered";
  if (failProvider) throw new Error("Ambiguous provider failure");
  return { sid: "SMoffline-fixture", status: "queued" };
} } } as any));
beforeEach(() => {
  messages = []; ledger = []; calls = []; kill = false; failLedger = false; failProvider = false; pauseAfterLedger = false; earlyReceipt = false;
  process.env.SMS_LIVE = "true"; process.env.SMS_TEST_OVERRIDE_TO = "+15551234567";
  process.env.PUBLIC_API_URL = "https://operator.example";
  setTwilioClockForTests(() => new Date("2026-10-07T16:00:00Z"));
});
test("unset override refuses before DB writes or transport", async () => {
  delete process.env.SMS_TEST_OVERRIDE_TO;
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /OVERRIDE/);
  assert.equal(messages.length + ledger.length + calls.length, 0);
});
test("kill switch and live-off block without creating an approval or send", async () => {
  kill = true;
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /kill switch/);
  kill = false; process.env.SMS_LIVE = "false";
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /Live sending/);
  assert.equal(messages.length + ledger.length + calls.length, 0);
});
test("send window blocks operator tests", async () => {
  setTwilioClockForTests(() => new Date("2026-10-07T06:00:00Z"));
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /window/);
  assert.equal(calls.length, 0);
});
test("kill switch is checked again immediately before provider submission", async () => {
  pauseAfterLedger = true;
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /kill switch/);
  assert.equal(calls.length, 0);
  assert.equal(messages[0].status, "failed");
  assert.equal(ledger[0].is_test, true);
});
test("fixed override transport persists test message, ledger, actor, SID, and refreshed receipt", async () => {
  const result = await sendOperatorTestMessage("club", "operator:fixture");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "+15551234567");
  assert.equal(calls[0].body, OPERATOR_TEST_TEXT);
  assert.equal(new URL(calls[0].statusCallback).pathname, "/api/messages/webhook/status");
  assert.equal(new URL(calls[0].statusCallback).searchParams.get("operator_test_id"), result.message_id);
  assert.equal(messages[0].retention_delivery_kind, "test");
  assert.equal(messages[0].player_id, null);
  assert.equal(messages[0].approved_at, null);
  assert.equal(messages[0].approved_by, null);
  assert.equal(ledger[0].is_test, true);
  assert.equal(ledger[0].player_id, null);
  assert.match(ledger[0].outcome, /operator:fixture/);
  assert.equal(result.twilio_sid, "SMoffline-fixture");
  messages[0].delivery_status = "delivered"; // persisted status callback result
  assert.equal((await getOperatorTestMessages("club"))[0].delivery_status, "delivered");
});
test("an early delivery receipt is not overwritten by the provider's queued response", async () => {
  earlyReceipt = true;
  await sendOperatorTestMessage("club", "operator:fixture");
  assert.equal((await getOperatorTestMessages("club"))[0].delivery_status, "delivered");
});
test("ledger failure prevents transport; provider failure preserves a claimed audited failure", async () => {
  failLedger = true;
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /audit/);
  assert.equal(calls.length, 0);
  failLedger = false; failProvider = true;
  await assert.rejects(sendOperatorTestMessage("club", "operator:fixture"), /provider/);
  assert.equal(calls.length, 1);
  assert.equal(messages.at(-1).status, "failed");
  assert.ok(messages.at(-1).dispatch_token);
  assert.equal(JSON.parse(ledger[0].outcome).result, "attempted");
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

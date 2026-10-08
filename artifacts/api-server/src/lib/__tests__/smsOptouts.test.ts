import assert from "node:assert/strict";
import { test } from "node:test";
import { supabase } from "../supabaseClient";
import { alertOptOutEvent, recordCarrierOptOutEvent } from "../smsOptouts";
import { setOperatorAlertTransportForTests } from "../operatorMonitoring";
import { setBackgroundJobsEnabledForTests } from "../backgroundPolicy";

test("opt-out alerts: event claim deduplication, success evidence, backfill suppression and ambiguous failures", async () => {
  const originalFrom = supabase.from;
  const originalRpc = supabase.rpc;
  const envKeys = ["NODE_ENV", "RUN_BACKGROUND_JOBS", "ALERT_OPERATOR_TO", "TWILIO_PHONE_NUMBER"] as const;
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  let submitted = 0, fail = false, claimed = false;
  const event: any = { id: "event", alerted_at: null, is_backfill: false };
  const alert: any = { id: "alert", incident_id: "incident", phase: "alert", status: "claimed" };
  const carrier: any[] = [];
  const query = (table: string) => {
    let payload: any, action = "select";
    const predicates: ((row: any) => boolean)[] = [];
    const q: any = {
      select() { return q; }, eq(key: string, value: any) { predicates.push(r => r[key] === value); return q; },
      is(key: string, value: any) { predicates.push(r => r[key] == value); return q; },
      update(value: any) { action = "update"; payload = value; return q; },
      upsert(value: any) { action = "upsert"; payload = value; return q; },
      maybeSingle() { return Promise.resolve(resolve(true)); },
      then(yes: any, no: any) { return Promise.resolve(resolve(false)).then(yes, no); },
    };
    const resolve = (single: boolean) => {
      let rows: any[] = table === "sms_optout_events" ? [event, ...carrier]
        : table === "sms_optouts" ? [{ id: "event", name: "Fixture Player", event_source: "stop_reply", playbook_key: "ltp_followup", step: 1, body: "Fixture invitation" }]
        : table === "operator_alert_incidents" ? [{ incident_id: "incident", condition_key: "sms-optout:event" }]
        : table === "operator_alert_events" ? [alert]
        : table === "players" ? [{ id: "player", club_id: "club" }] : [];
      if (action === "upsert" && !carrier.some(r => r.message_id === payload.message_id)) carrier.push({ id: "carrier", ...payload });
      rows = rows.filter(row => predicates.every(p => p(row)));
      if (action === "update") rows.forEach(row => Object.assign(row, payload));
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    return q;
  };
  try {
    process.env.NODE_ENV = "test"; process.env.RUN_BACKGROUND_JOBS = "true";
    setBackgroundJobsEnabledForTests(true);
    process.env.ALERT_OPERATOR_TO = "+12015550001"; process.env.TWILIO_PHONE_NUMBER = "+12015550002";
    (supabase as any).from = query;
    (supabase as any).rpc = async () => ({ data: claimed ? null : (claimed = true, { id: "alert", incident_id: "incident", phase: "alert", text: "Fixture" }), error: null });
    setOperatorAlertTransportForTests(async () => { submitted++; if (fail) throw new Error("fixture ambiguous outcome"); });
    await alertOptOutEvent("event");
    assert.ok(event.alerted_at);
    await alertOptOutEvent("event");
    assert.equal(submitted, 1, "replayed event must not submit a second alert");
    event.alerted_at = null; event.is_backfill = true;
    await alertOptOutEvent("event");
    assert.equal(submitted, 1, "backfills never alert");
    event.is_backfill = false; claimed = false; fail = true; alert.status = "claimed";
    await assert.rejects(alertOptOutEvent("event"), /could not be accepted/);
    assert.equal(event.alerted_at, null);
    await assert.rejects(alertOptOutEvent("event"), /reconciliation/);
    assert.equal(submitted, 2, "ambiguous provider acceptance must not be retried automatically");
    await recordCarrierOptOutEvent("player", "message", "2026-10-08T12:00:00Z");
    await recordCarrierOptOutEvent("player", "message", "2026-10-08T13:00:00Z");
    assert.equal(carrier.length, 1);
    assert.equal(carrier[0].occurred_at, "2026-10-08T12:00:00Z");
  } finally {
    setOperatorAlertTransportForTests(null);
    setBackgroundJobsEnabledForTests(false);
    supabase.from = originalFrom; supabase.rpc = originalRpc;
    for (const key of envKeys) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  }
});

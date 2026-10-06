import assert from "node:assert/strict";
import { test, after } from "node:test";
import { supabase } from "../supabaseClient";
import { operatorAlertReasons, alertOperator, runtimeHealth, setOperatorAlertTransportForTests } from "../operatorMonitoring";
import { setBackgroundJobsEnabledForTests } from "../backgroundPolicy";
const original = { from: supabase.from, rpc: supabase.rpc, env: { ...process.env } };
process.env.NODE_ENV = "test";
setBackgroundJobsEnabledForTests(true);
process.env.RUN_BACKGROUND_JOBS = "false";
let writes = 0;
let submits = 0;
let failDb = false;
(supabase as any).from = (table: string) => {
  const q: any = {
    select: () => q, eq: () => q, in: () => q,
    upsert: () => { writes++; return q; },
    maybeSingle: () => Promise.resolve(resolve()),
    then: (yes: any, no: any) => Promise.resolve(resolve()).then(yes, no),
  };
  function resolve() {
    if (failDb) return { data: null, error: { message: "fixture offline" } };
    if (table === "clubs") return { data: { sms_kill_switch: false, scheduled_sync_time: "03:00", timezone: "America/New_York" }, error: null };
    if (table === "jobs") return { data: { status: "done", started_at: "2026-10-06T07:00:00Z", finished_at: "2026-10-06T08:00:00Z" }, error: null };
    return { data: table === "operator_runtime" ? [] : null, error: null };
  }
  return q;
};
(supabase as any).rpc = async () => ({ data: true, error: null });
setOperatorAlertTransportForTests(async () => { submits++; });

test("public health returns only aggregate state and degrades on DB failure", async () => {
  const health = await runtimeHealth();
  assert.equal(health.status, "ok");
  assert.equal(health.paused, false);
  assert.equal(health.last_nightly_sync.result, "done");
  assert.equal(health.last_nightly_sync.at, "2026-10-06T08:00:00Z");
  assert.doesNotMatch(JSON.stringify(health), /player|phone|message_body|token|password/i);
  failDb = true;
  const degraded = await runtimeHealth();
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.db_reachable, false);
  assert.equal(degraded.paused, null);
  failDb = false;
});
test("watchdog detects stale queue and missed/failed nightly sync without alerting a fresh worker", async () => {
  const now = Date.parse("2026-10-06T15:00:00Z");
  const health = await runtimeHealth();
  assert.deepEqual(operatorAlertReasons(health, now, now), []);
  assert.ok(operatorAlertReasons({ ...health, last_queue_tick_at: new Date(now - 16 * 60 * 1000).toISOString() }, now).some((r) => r.key === "queue_stale"));
  assert.ok(operatorAlertReasons({ ...health, schedule: { ...health.schedule!, last_started_at: null }, last_nightly_sync: { result: "never", at: null } }, now, now).some((r) => r.key.startsWith("nightly_missing")));
  assert.ok(operatorAlertReasons({ ...health, last_nightly_sync: { result: "error", at: "2026-10-06T09:00:00Z" } }, now, now).some((r) => r.key.startsWith("nightly:")));
  const afterMidnight = Date.parse("2026-10-07T05:30:00Z");
  assert.ok(operatorAlertReasons({ ...health, schedule: { time: "23:50", timezone: "America/New_York", last_started_at: null },
    last_nightly_sync: { result: "never", at: null } }, afterMidnight, afterMidnight).some((r) => r.key.startsWith("nightly_missing")));
});
test("alerts are off in dev, operator-only when enabled, and deduplicated; no live transport", async () => {
  await alertOperator("offline-fixture-alert", "Offline test");
  assert.equal(submits, 0);
  assert.equal(writes, 0);
  process.env.RUN_BACKGROUND_JOBS = "true";
  process.env.ALERT_OPERATOR_TO = "+15551234567";
  process.env.TWILIO_PHONE_NUMBER = "+15557654321";
  await alertOperator("offline-fixture-alert", "Offline test");
  assert.equal(submits, 1);
  await alertOperator("offline-fixture-alert", "Offline test");
  assert.equal(submits, 1);
  process.env.RUN_BACKGROUND_JOBS = "false";
});
after(() => {
  setBackgroundJobsEnabledForTests(false);
  setOperatorAlertTransportForTests(null);
  (supabase as any).from = original.from;
  (supabase as any).rpc = original.rpc;
  for (const key of ["NODE_ENV", "RUN_BACKGROUND_JOBS", "ALERT_OPERATOR_TO", "TWILIO_PHONE_NUMBER"]) {
    if (original.env[key] === undefined) delete process.env[key];
    else process.env[key] = original.env[key];
  }
});

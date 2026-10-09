import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import express from "express";
import { supabase } from "../../lib/supabaseClient";
import reportsRouter from "../retentionReports";

const clubId = "00000000-0000-4000-8000-000000000001";
const originalFrom = supabase.from;
const tables: string[] = [];
let schemaMissing = false;
const outcome = {
  sequence_id: "00000000-0000-4000-8000-000000000002", player_id: "00000000-0000-4000-8000-000000000003",
  name: "Fixture Player", playbook_key: "ltp_followup", step1_sent_at: new Date().toISOString(),
  step2_sent_at: null, last_sent_at: new Date().toISOString(), sequence_status: "active", exit_reason: null,
  replied: false, booked: false, booked_event_id: null, booked_program_name: null, booking_created_at: null,
  credited_step: null, coupon_code_used: null, days_to_book: null, opted_out: false, opted_out_at: null,
  optout_after_step: null, optout_message_id: null, hours_to_optout: null,
  step1_drafted: true, step1_approved: true, step1_sent: true, step1_delivered: true, step1_booked: false,
  step2_drafted: false, step2_approved: false, step2_sent: false, step2_delivered: false, step2_booked: false,
  outcome: "in_window", window_closes_at: new Date(Date.now() + 21 * 86400_000).toISOString(), is_test: false,
};
const testPlayerId = "00000000-0000-4000-8000-000000000004";
const optout = {
  id: "00000000-0000-4000-8000-000000000010", player_id: outcome.player_id,
  name: "Normal fixture", opted_out_at: new Date().toISOString(), source: "unattributed",
  event_source: "stop_reply", twilio_optout_type: "STOP", playbook_key: null, step: null,
  body: null, optout_message_id: null, is_test: false,
};
function query(table: string) {
  tables.push(table);
  const filters: Record<string, any> = {};
  let fields = "";
  const resolve = (single = false) => {
    if (table === "clubs") return { data: { id: clubId, slug: "reports-fixture", name: "Fixture", timezone: "America/New_York" }, error: null };
    assert.equal(filters.club_id, clubId, "every private view read is club-scoped");
    if (table === "playbook_outcomes") assert.equal(filters.is_test, false, "test sequences excluded from all cohort reads");
    if (schemaMissing) return { data: null, error: { code: "PGRST205", message: "fixture missing reporting view" } };
    const rows = table === "playbook_outcomes"
      ? (!filters.playbook_key || filters.playbook_key === outcome.playbook_key ? [
        outcome, { ...outcome, sequence_id: testPlayerId, player_id: testPlayerId },
      ] : [])
      : table === "ltp_baseline" ? [{ n_players: 4, n_booked: 1, rate: 0.25 }]
      : table === "players" ? [{ id: testPlayerId }]
      : table === "sms_optouts" ? [optout, { ...optout, id: testPlayerId, player_id: testPlayerId, is_test: true }] : [];
    if (table === "players") assert.equal(filters.is_test, true);
    const selected = rows.map(row => Object.fromEntries(fields.split(",").map(f => [f, (row as any)[f]])));
    return { data: single ? selected[0] ?? null : selected, error: null };
  };
  const q: any = {
    select(value: string) { fields = value; return q; },
    eq(key: string, value: any) { filters[key] = value; return q; },
    gte(key: string, value: any) { assert.equal(key, "step1_sent_at"); assert.ok(Number.isFinite(Date.parse(value))); return q; },
    order() { return q; },
    range() { return Promise.resolve(resolve()); },
    maybeSingle() { return Promise.resolve(resolve(true)); },
  };
  return q;
}
const app = express();
app.use((req, _res, next) => { (req as any).log = { info() {}, error() {} }; next(); });
app.use(reportsRouter);
let server: ReturnType<typeof app.listen>, base: string;
before(async () => {
  (supabase as any).from = query;
  await new Promise<void>(resolve => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(async () => { supabase.from = originalFrom; await new Promise<void>(resolve => server.close(() => resolve())); });

test("reports is SELECT-only, club-scoped, validated, and baseline is flow-specific", async () => {
  const response = await fetch(`${base}/retention/reports?slug=reports-fixture&period=30d`);
  assert.equal(response.status, 200);
  const report = await response.json() as any;
  assert.equal(report.outcomes.length, 1);
  assert.deepEqual(report.playbook_keys, ["ltp_followup"]);
  assert.deepEqual(report.baseline, { n_players: 4, n_booked: 1, rate: 0.25 });
  assert.equal(report.club_opt_out_total, 1, "test opt-out excluded from club-wide total");
  assert.equal(report.optouts.length, 2, "test opt-out retained in the panel");
  assert.equal(report.optouts.filter((row: any) => row.is_test).length, 1);
  assert.ok(report.outcomes.every((row: any) => row.player_id !== testPlayerId), "test player excluded from scorecard");
  tables.length = 0;
  const other = await fetch(`${base}/retention/reports?slug=reports-fixture&playbook_key=other&period=all`);
  assert.equal(other.status, 200);
  assert.equal((await other.json() as any).baseline, null);
  assert.ok(!tables.includes("ltp_baseline"));
  assert.equal((await fetch(`${base}/retention/reports?slug=reports-fixture&period=invalid`)).status, 400);
  schemaMissing = true;
  assert.equal((await fetch(`${base}/retention/reports?slug=reports-fixture`)).status, 503);
});

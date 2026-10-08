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
};
function query(table: string) {
  tables.push(table);
  const filters: Record<string, any> = {};
  let fields = "";
  const resolve = (single = false) => {
    if (table === "clubs") return { data: { id: clubId, slug: "reports-fixture", name: "Fixture", timezone: "America/New_York" }, error: null };
    assert.equal(filters.club_id, clubId, "every private view read is club-scoped");
    if (schemaMissing) return { data: null, error: { code: "PGRST205", message: "fixture missing reporting view" } };
    const rows = table === "playbook_outcomes"
      ? (!filters.playbook_key || filters.playbook_key === outcome.playbook_key ? [outcome] : [])
      : table === "ltp_baseline" ? [{ n_players: 4, n_booked: 1, rate: 0.25 }] : [];
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
  assert.equal(report.club_opt_out_total, 0);
  tables.length = 0;
  const other = await fetch(`${base}/retention/reports?slug=reports-fixture&playbook_key=other&period=all`);
  assert.equal(other.status, 200);
  assert.equal((await other.json() as any).baseline, null);
  assert.ok(!tables.includes("ltp_baseline"));
  assert.equal((await fetch(`${base}/retention/reports?slug=reports-fixture&period=invalid`)).status, 400);
  schemaMissing = true;
  assert.equal((await fetch(`${base}/retention/reports?slug=reports-fixture`)).status, 503);
});

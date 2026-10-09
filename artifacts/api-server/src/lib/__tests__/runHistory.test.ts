import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import { operatorPostgresFixture } from "./fixtures/operatorPostgres";
import { supabase } from "../supabaseClient";
import { generateRetentionDrafts } from "../retentionEngine";
import {
  withGenerationRun, withNightlyRun, observeSyncStep, recordPlayerOutcome,
  flushRunHistoryForTests, runHistoryRequestContext,
} from "../runHistory";
import { checkNightlyRunAlerts, nightlyScheduleWindow } from "../nightlyRunAlerts";
import { operatorConditionKey } from "../operatorMonitoring";
import historyRouter from "../../routes/runHistory";

const CLUB = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const PLAYER = "00000000-0000-4000-8000-000000000003";
const literal = (value: unknown) => value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;

test("run history SQL, real all-skipped engine, partial failure, private API, and once-per-date alerts", async (t) => {
  const db = operatorPostgresFixture(); // Isolated socket-only PostgreSQL. Never a workspace/Supabase database.
  const savedFrom = supabase.from;
  const savedRpc = supabase.rpc;
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  let writeMode: "normal" | "missing" | "stall" = "normal";
  const readRows = (table: string) => JSON.parse(db.sql(`SELECT COALESCE(jsonb_agg(t),'[]') FROM ${table} t`));
  const migration = readFileSync(new URL("../../../migrations/029_generation_and_nightly_run_history.sql", import.meta.url), "utf8");
  // The URL is relative to src/lib/__tests__, not the package root.
  try {
    db.sql(migration);
    db.sql(migration);
    db.sql(`ALTER TABLE clubs ADD COLUMN timezone text DEFAULT 'America/New_York',ADD COLUMN scheduled_sync_time text DEFAULT '03:00';
      INSERT INTO clubs(id,slug,sms_kill_switch) VALUES('${OTHER}','other',true);
      CREATE TABLE test_alert_claims(key text PRIMARY KEY);`);
    const calls: string[] = [];
    (supabase as any).from = (table: string) => {
      assert.ok(["retention_generation_runs", "nightly_sync_runs", "clubs", "retention_playbooks", "attendances"].includes(table), `Unexpected table: ${table}`);
      let rows: any[], single = false;
      const filters: ((row: any) => boolean)[] = [];
      const orders: { field: string; ascending: boolean }[] = [];
      let limit = Infinity;
      const query: any = {
        select: () => query,
        eq: (field: string, value: unknown) => { filters.push(row => field.split(".").reduce((item, key) => item?.[key], row) === value); return query; },
        in: (field: string, values: unknown[]) => { filters.push(row => values.includes(row[field])); return query; },
        gte: (field: string, value: string) => { filters.push(row => row[field] && Date.parse(row[field]) >= Date.parse(value)); return query; },
        lte: (field: string, value: string) => { filters.push(row => row[field] && Date.parse(row[field]) <= Date.parse(value)); return query; },
        order: (field: string, options: any) => { orders.push({ field, ascending: options.ascending }); return query; },
        range: () => query,
        limit: (value: number) => { limit = value; return query; },
        single: () => { single = true; return query; },
        maybeSingle: () => { single = true; return query; },
        then: (resolve: any, reject: any) => {
          if (table === "retention_playbooks") rows = [{ key: "ltp_followup", enabled: true, promo_code: null }];
          else if (table === "attendances") rows = [{ id: "old-attendance", player_id: PLAYER, event_id: "ltp-fixture",
            program_name: "Learn to Play", attended_at: "2020-01-02T15:00:00Z", players: { club_id: CLUB, name: "Fixture player" } }];
          else rows = readRows(table);
          rows = rows.filter(row => filters.every(filter => filter(row)));
          rows.sort((a, b) => {
            for (const { field, ascending } of orders) {
              const diff = String(a[field]).localeCompare(String(b[field]));
              if (diff) return ascending ? diff : -diff;
            }
            return 0;
          });
          rows = rows.slice(0, limit);
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve, reject);
        },
        upsert: (row: any) => ({
          abortSignal: (signal: AbortSignal) => {
            if (writeMode === "missing") return Promise.resolve({ data: null, error: { code: "42P01", message: "Fixture missing schema" } });
            if (writeMode === "stall") return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Fixture logging timeout")), { once: true }));
            const json = literal(JSON.stringify(row));
            const columns = Object.keys(row);
            db.sql(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},${json}::jsonb)
              ON CONFLICT(id) DO UPDATE SET ${columns.filter(key => key !== "id").map(key => `${key}=excluded.${key}`).join(",")};`);
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
      return query;
    };
    (supabase as any).rpc = async (name: string) => {
      assert.equal(name, "retention_sequence_ready"); // Any external RPC would fail the test.
      return { data: true, error: null };
    };

    await t.test("all-skipped actual generator writes one successful named history row, preserving existing counters", async () => {
      const generated = await generateRetentionDrafts(CLUB);
      await flushRunHistoryForTests();
      const rows = readRows("retention_generation_runs");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, generated.run_id);
      assert.equal(rows[0].status, "success");
      assert.equal(rows[0].evaluated, 1); assert.equal(rows[0].drafted, 0); assert.equal(rows[0].skipped, 1);
      assert.equal(rows[0].details.outcomes[0].player_name, "Fixture player");
      assert.match(rows[0].details.outcomes[0].reason, /Outside the 3-day/);
      assert.equal(generated.stats.created, 0); assert.equal(generated.stats.skipped, 0);
      assert.ok(rows[0].finished_at);
    });
    await t.test("nested generation produces one row; thrown failures retain partial outcomes", async () => {
      const original = new Error("Fixture write failed");
      await assert.rejects(withGenerationRun(CLUB, "ltp_followup", "Generate", async () => {
        recordPlayerOutcome(PLAYER, "Fixture player", "drafted", "Draft ready");
        await withGenerationRun(CLUB, "ltp_followup", "Regenerate", async () => ({ results: [] }));
        throw original;
      }), error => error === original);
      await flushRunHistoryForTests();
      const rows = readRows("retention_generation_runs");
      assert.equal(rows.length, 2);
      const row = rows.find((item: any) => item.id === (original as any).run_id);
      assert.equal(row.status, "failed"); assert.equal(row.drafted, 1); assert.equal(row.errors, 1);
    });
    await t.test("mid-chain sync records completed/failed/unrun steps in one row and never executes later steps", async () => {
      let laterExecuted = false;
      await assert.rejects(withNightlyRun(CLUB, "manual", async () => {
        await observeSyncStep("Player import and DUPR refresh", async () => ({ players_upserted: 9 }));
        await observeSyncStep("Event/attendance sync", async () => { throw new Error("Fixture attendance lookup failed"); });
        laterExecuted = true;
      }), /Fixture attendance lookup failed/);
      await flushRunHistoryForTests();
      const rows = readRows("nightly_sync_runs");
      assert.equal(rows.length, 1); assert.equal(rows[0].status, "failed"); assert.equal(laterExecuted, false);
      assert.equal(rows[0].steps[0].counts.players_upserted, 9);
      assert.equal(rows[0].steps[1].status, "failed"); assert.match(rows[0].steps[1].error, /lookup failed/);
      assert.ok(rows[0].steps[1].finished_at);
      assert.equal(rows[0].steps.find((step: any) => step.name === "Retention step-1 drafts").status, "skipped");
    });
    await t.test("nightly generation is linked, tagged nightly and never attributed to a button operator", async () => {
      await withNightlyRun(CLUB, "scheduled", () => observeSyncStep("Retention step-1 drafts",
        () => withGenerationRun(CLUB, "ltp_followup", "Generate", async () => ({ results: [] }))));
      await flushRunHistoryForTests();
      const sync = readRows("nightly_sync_runs").find((row: any) => row.status === "success");
      const generation = readRows("retention_generation_runs").find((row: any) => row.id === sync.steps[0].generation_run_id);
      assert.equal(generation.trigger, "nightly"); assert.equal(generation.operator, null);
    });
    await t.test("logging outages and a stalled logger do not block/change the returned operation", async () => {
      writeMode = "missing";
      assert.equal((await withGenerationRun(CLUB, null, "Generate", async () => ({ preserved: 42 }))).preserved, 42);
      await flushRunHistoryForTests();
      writeMode = "stall";
      const start = performance.now();
      assert.equal((await withGenerationRun(CLUB, null, "Generate", async () => ({ preserved: 7 }))).preserved, 7);
      assert.ok(performance.now() - start < 500, "A logging timeout must not delay the original operation");
      const holdOpen = setTimeout(() => {}, 4000);
      try { await flushRunHistoryForTests(); } finally { clearTimeout(holdOpen); }
      writeMode = "normal";
    });
    await t.test("migration keeps names private to operator API; RLS and grants are installed", () => {
      assert.equal(db.sql(`SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname IN('retention_generation_runs','nightly_sync_runs')`), "t");
      assert.equal(db.sql(`SELECT has_table_privilege('anon','retention_generation_runs','SELECT') OR has_table_privilege('authenticated','nightly_sync_runs','SELECT')`), "f");
      assert.equal(db.sql(`SELECT has_table_privilege('service_role','retention_generation_runs','INSERT')`), "t");
    });
    await t.test("failed-run watchdog repeats the same claim and names the failed step", async () => {
      db.sql(`INSERT INTO nightly_sync_runs VALUES(
        '00000000-0000-4000-8000-000000000090','${CLUB}','2030-02-01T08:00Z','2030-02-01T08:15Z','failed','scheduled',
        '[{"name":"Event/attendance sync","status":"failed","error":"Fixture failure"}]')`);
      const sent: string[] = [];
      const alert = async (key: string, text: string) => {
        const claimed = db.sql(`WITH claimed AS (
          INSERT INTO test_alert_claims VALUES(${literal(operatorConditionKey(key))}) ON CONFLICT DO NOTHING RETURNING key
        ) SELECT count(*) FROM claimed`);
        if (claimed === "1") sent.push(text);
      };
      await checkNightlyRunAlerts(CLUB, "03:00", "America/New_York", alert, new Date("2030-02-01T08:30Z"));
      await checkNightlyRunAlerts(CLUB, "03:00", "America/New_York", alert, new Date("2030-02-01T08:31Z"));
      assert.equal(sent.length, 1); assert.match(sent[0], /failed at Event\/attendance sync/);
    });
    await t.test("missed completion alert claims exactly once per local date, not on start or after a late completion", async () => {
      db.sql("DELETE FROM nightly_sync_runs");
      const alert = async (key: string, text: string) => {
        const claimed = db.sql(`WITH claimed AS (
          INSERT INTO test_alert_claims VALUES(${literal(operatorConditionKey(key))}) ON CONFLICT DO NOTHING RETURNING key
        ) SELECT count(*) FROM claimed`);
        if (claimed === "1") calls.push(text);
      };
      await checkNightlyRunAlerts(CLUB, "03:00", "America/New_York", alert, new Date("2026-10-08T08:59:59Z"));
      assert.equal(calls.length, 0);
      for (let tick = 0; tick < 3; tick++) await checkNightlyRunAlerts(CLUB, "03:00", "America/New_York", alert, new Date("2026-10-08T09:00:01Z"));
      assert.equal(calls.length, 1);
      assert.match(db.sql("SELECT key FROM test_alert_claims"), /2026-10-08/);
      await checkNightlyRunAlerts(CLUB, "03:00", "America/New_York", alert, new Date("2026-10-09T09:00:01Z"));
      assert.equal(calls.length, 2);
      // A start alone is not a completion, and an overdue completion is not on time.
      db.sql(`INSERT INTO nightly_sync_runs VALUES('00000000-0000-4000-8000-000000000010','${CLUB}','2026-10-10T07:00Z','2026-10-10T09:10Z','success','scheduled','[]')`);
      await checkNightlyRunAlerts(CLUB, "03:00", "America/New_York", alert, new Date("2026-10-10T09:20Z"));
      assert.equal(calls.length, 3);
      db.sql(`INSERT INTO nightly_sync_runs VALUES('00000000-0000-4000-8000-000000000011','${CLUB}','2026-10-11T07:00Z','2026-10-11T08:59Z','partial','scheduled','[]')`);
      await checkNightlyRunAlerts(CLUB, "03:00", "America/New_York", alert, new Date("2026-10-11T09:20Z"));
      assert.equal(calls.length, 3, "A completed chain with nonfatal step errors still completed");
      assert.equal(nightlyScheduleWindow(new Date("2026-11-01T15:00Z"), "03:00", "America/New_York").scheduledAt.toISOString(), "2026-11-01T08:00:00.000Z");
      assert.equal(nightlyScheduleWindow(new Date("2026-03-08T15:00Z"), "03:00", "America/New_York").scheduledAt.toISOString(), "2026-03-08T07:00:00.000Z");
    });
    await t.test("history API is club-scoped, returns last14, and follows a specific run outside that list", async () => {
      const app = express();
      app.use((req, res, next) => {
        (req as any).log = { info: () => {}, warn: () => {}, error: (data: any) => console.error("Fixture history API error", data) };
        if (req.headers["fixture-auth"] !== "operator") { res.status(401).json({ error: "Operator required" }); return; }
        res.locals.operator = { actor: "Fixture operator" }; next();
      });
      app.use(runHistoryRequestContext, historyRouter);
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server.once("listening", resolve));
      const address = server.address() as any;
      const root = `http://127.0.0.1:${address.port}`;
      try {
        assert.equal((await fetch(`${root}/retention/generation-runs?slug=pb-club`)).status, 401);
        const own = readRows("retention_generation_runs")[0];
        const wrongClub = await fetch(`${root}/retention/generation-runs?slug=other&run_id=${own.id}`, { headers: { "fixture-auth": "operator" } });
        assert.equal(wrongClub.status, 404, await wrongClub.text());
        for (let index = 0; index < 15; index++) await withGenerationRun(CLUB, null, "Generate", async () => ({ results: [] }));
        await flushRunHistoryForTests();
        const response = await fetch(`${root}/retention/generation-runs?slug=pb-club`, { headers: { "fixture-auth": "operator" } });
        assert.equal(response.status, 200); assert.equal((await response.json() as any).runs.length, 14);
        const selected = await fetch(`${root}/retention/generation-runs?slug=pb-club&run_id=${own.id}`, { headers: { "fixture-auth": "operator" } });
        assert.equal(selected.status, 200); assert.equal((await selected.json() as any).runs[0].id, own.id);
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });
  } finally {
    await flushRunHistoryForTests();
    (supabase as any).from = savedFrom; (supabase as any).rpc = savedRpc;
    if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
    db.close();
  }
});

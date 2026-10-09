import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { supabase } from "../../lib/supabaseClient";
import playersRouter from "../players";
import { optOutWebhookPostgres } from "../../lib/__tests__/fixtures/optOutWebhookPostgres";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const club = id(1), other = id(2), player = id(80);

test("read-only player endpoints: native SQL ownership counts, current flags, private latest event, errors and club isolation", async () => {
  const db = optOutWebhookPostgres(true);
  const originalFrom = supabase.from, originalRpc = supabase.rpc;
  let errorTable: string | null = null;
  const reads: string[] = [];
  const quote = (value: unknown) => value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
  const column = (name: string) => {
    assert.match(name, /^[a-z_]+(?:\.[a-z_]+)?$/);
    return name.startsWith("players.") ? `p.${name.split(".")[1]}`
      : name.startsWith("conversations.") ? `c.${name.split(".")[1]}` : `t.${name}`;
  };
  // Execute the SDK's read predicates and joins against native PostgreSQL;
  // messages deliberately has NO club_id column.
  supabase.from = ((table: string) => {
    assert.ok(["clubs", "players", "messages", "sms_optout_events"].includes(table));
    reads.push(table);
    const filters: string[] = [], orders: string[] = [];
    let fields = "", head = false, limit = "";
    const resolve = (single = false) => {
      if (errorTable === table) return { data: null, count: null, error: { code: "42703", message: "Synthetic read failure" } };
      let join = "";
      if (fields.includes("players!inner")) join = " JOIN players p ON p.id=t.player_id";
      if (fields.includes("conversations!inner")) join = " JOIN conversations c ON c.id=t.conversation_id";
      const source = `FROM ${table} t${join}${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}`;
      if (head) return { data: null, error: null, count: Number(db.sql(`SELECT count(*) ${source}`)) };
      const data = JSON.parse(db.sql(`SELECT COALESCE(jsonb_agg(to_jsonb(rows)),'[]') FROM
        (SELECT t.* ${source}${orders.length ? ` ORDER BY ${orders.join(",")}` : ""}${limit}) rows`));
      return { data: single ? data[0] ?? null : data, error: null };
    };
    const query: any = {
      select(value: string, options?: { head?: boolean }) { fields = value; head = !!options?.head; return query; },
      eq(key: string, value: unknown) { filters.push(`${column(key)}=${quote(value)}`); return query; },
      is(key: string, value: unknown) { assert.equal(value, null); filters.push(`${column(key)} IS NULL`); return query; },
      not(key: string, operator: string, value: unknown) {
        assert.equal(operator, "is"); assert.equal(value, null);
        filters.push(`${column(key)} IS NOT NULL`); return query;
      },
      gte(key: string, value: unknown) { filters.push(`${column(key)}>=${quote(value)}`); return query; },
      order(key: string, options: { ascending: boolean }) { orders.push(`${column(key)} ${options.ascending ? "ASC" : "DESC"}`); return query; },
      limit(n: number) { assert.equal(n, 1); limit = " LIMIT 1"; return query; },
      maybeSingle() { return Promise.resolve(resolve(true)); },
      then(yes: any, no: any) { return Promise.resolve().then(() => resolve()).then(yes, no); },
    };
    return query;
  }) as typeof supabase.from;
  supabase.rpc = (() => { throw new Error("No RPC or mutation allowed"); }) as typeof supabase.rpc;
  const app = express();
  app.use((req, _res, next) => { (req as any).log = { error() {}, info() {}, warn() {} }; next(); });
  app.use("/api", playersRouter);
  const server = app.listen(0, "127.0.0.1");
  try {
    db.sql(`ALTER TABLE messages ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN converted_at timestamptz;
      INSERT INTO clubs VALUES('${other}','readouts-other',true);
      INSERT INTO players(id,club_id,name,phone,opted_out,sms_opt_in) VALUES
        ('${player}','${club}','Readout fixture','+15550000180',false,true),
        ('${id(81)}','${other}','Other fixture','+15550000181',false,true);
      INSERT INTO conversations(id,club_id,player_id) VALUES
        ('${id(82)}','${club}','${player}'),('${id(83)}','${other}','${id(81)}');
      INSERT INTO messages(player_id,conversation_id,direction,status,converted_at) VALUES
        ('${player}',NULL,'outbound','sent',now()),
        ('${player}','${id(82)}','outbound','sent',NULL),
        (NULL,'${id(82)}','outbound','sent',now()),
        ('${id(81)}','${id(82)}','outbound','sent',now()),
        (NULL,'${id(83)}','outbound','sent',NULL),
        ('${player}',NULL,'inbound','sent',now()),
        ('${player}',NULL,'outbound','pending',now()),
        (NULL,NULL,'outbound','sent',now());
      INSERT INTO messages(player_id,direction,status,created_at,converted_at)
        VALUES('${player}','outbound','sent',now()-interval '31 days',now());
      INSERT INTO sms_optout_events(id,club_id,player_id,source,occurred_at,created_at) VALUES
        ('${id(84)}','${club}','${player}','stop_reply','2026-10-01',now()-interval '2 days'),
        ('${id(85)}','${club}','${player}','carrier_21610','2026-10-02',now()-interval '1 day'),
        ('${id(86)}','${other}','${player}','manual','2026-10-03',now());`);
    await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const get = async (path: string, clubId = club) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/players/${path}?clubId=${clubId}`);
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    assert.deepEqual(await get("winback-stats"), { status: 200, body: {
      period_days: 30, messages_sent: 3, conversions: 2, conversion_rate_pct: 67,
    } });
    assert.equal((await get("winback-stats", other)).body.messages_sent, 2);
    const active = await get(`${player}/sms-status`);
    assert.equal(active.body.status, "active", "old STOP history cannot override current START flags");
    assert.equal(active.body.latest_optout_event.source, "carrier_21610", "newest recorded same-club event wins");
    assert.deepEqual(Object.keys(active.body.latest_optout_event).sort(), ["occurred_at", "source", "twilio_optout_type"]);
    db.sql(`UPDATE players SET opted_out=true,sms_opt_in=false WHERE id='${player}';`);
    assert.equal((await get(`${player}/sms-status`)).body.status, "opted_out");
    db.sql(`UPDATE players SET opted_out=false WHERE id='${player}';`);
    assert.equal((await get(`${player}/sms-status`)).body.status, "opted_out", "sms_opt_in=false is honored even if opted_out=false");
    db.sql(`UPDATE players SET opted_out=true,sms_opt_in=true WHERE id='${player}';`);
    assert.equal((await get(`${player}/sms-status`)).body.status, "opted_out", "opted_out=true takes precedence over opt-in");
    db.sql(`DELETE FROM sms_optout_events WHERE club_id='${club}';`);
    const noHistory = await get(`${player}/sms-status`);
    assert.equal(noHistory.body.status, "opted_out");
    assert.equal(noHistory.body.latest_optout_event, null);
    db.sql(`UPDATE players SET opted_out=NULL,sms_opt_in=NULL WHERE id='${player}';`);
    assert.equal((await get(`${player}/sms-status`)).body.status, "unknown");
    const before = reads.filter(t => t === "sms_optout_events").length;
    assert.equal((await get(`${player}/sms-status`, other)).status, 404);
    assert.equal(reads.filter(t => t === "sms_optout_events").length, before, "no history read before ownership validation");
    assert.equal((await get("not-a-uuid/sms-status")).status, 400);
    errorTable = "messages";
    assert.equal((await get("winback-stats")).status, 500, "database failures are not fake zero counts");
    errorTable = "sms_optout_events";
    assert.equal((await get(`${player}/sms-status`)).status, 500, "missing private event schema is not displayed as Active");
    errorTable = "players";
    assert.equal((await get(`${player}/sms-status`)).status, 500);
    errorTable = null;
    assert.equal(db.sql("SELECT count(*) FROM messages"), "9", "read endpoints create no messages");
    assert.equal(db.sql("SELECT count(*) FROM retention_sequences"), "0");
    db.sql("DELETE FROM messages;");
    assert.deepEqual((await get("winback-stats")).body, {
      period_days: 30, messages_sent: 0, conversions: 0, conversion_rate_pct: null,
    }, "genuine zero counts remain valid");
  } finally {
    supabase.from = originalFrom;
    supabase.rpc = originalRpc;
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
});

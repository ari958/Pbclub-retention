import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { optOutWebhookPostgres } from "./fixtures/optOutWebhookPostgres";

test("028 reproduces the production column failure, changes only ordering, preserves grants/overloads, and captures reply/STOP/START", () => {
  const db = optOutWebhookPostgres(false, false);
  const load = (name: string) => readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
  const pattern = /CREATE OR REPLACE FUNCTION public\.capture_sms_inbound\([\s\S]*?END \$\$;/;
  const club = "00000000-0000-4000-8000-000000000001";
  const player = "00000000-0000-4000-8000-000000000070";
  const signature = "public.capture_sms_inbound(text,text,text,text,text,text)";
  const capture = (n: number, body: string) => JSON.parse(db.sql(
    `SELECT capture_sms_inbound('pb-club','+15550000170','+15550000998',
      'SM${n.toString(16).padStart(32, "0")}','${body}',NULL::text)`));
  try {
    const columns = JSON.parse(db.sql(`SELECT json_agg(column_name ORDER BY ordinal_position)
      FROM information_schema.columns WHERE table_schema='public' AND table_name='conversations'`));
    assert.deepEqual(columns, ["id", "player_id", "club_id", "triggered_by", "programs_offered",
      "outcome", "outcome_program", "attributed_booking", "attributed_at", "attributed_program",
      "opened_at", "closed_at", "updated_at"]);
    db.sql(`INSERT INTO players(id,club_id,name,phone) VALUES('${player}','${club}','Synthetic schema fixture','+15550000170');`);
    assert.throws(() => capture(70, "Hello"), /column "created_at" does not exist/);
    assert.equal(db.sql("SELECT count(*) FROM sms_inbound_receipts"), "0", "failed capture rolls back the receipt");
    assert.equal(db.sql("SELECT count(*) FROM messages"), "0");
    const before = db.sql(`SELECT oid||':'||proowner||':'||proacl::text FROM pg_proc WHERE oid='${signature}'::regprocedure`);
    const fiveBefore = db.sql("SELECT pg_get_functiondef('public.capture_sms_inbound(text,text,text,text,text)'::regprocedure)");
    const original = load("022_retention_reports_and_optouts.sql").match(pattern)?.[0];
    const migration = load("028_inbound_conversation_order.sql");
    assert.ok(original);
    assert.equal(migration.match(pattern)?.[0], original.replace(
      "ORDER BY created_at DESC,id DESC LIMIT 1", "ORDER BY opened_at DESC,id DESC LIMIT 1"));
    assert.equal(migration.replace(pattern, "").replace(/--[^\n]*/g, "").trim(), "",
      "028 contains exactly one function replacement; no grants, DDL or data changes outside it");
    db.sql(migration);
    db.sql(migration); // Reapplication is safe and still preserves the existing ACL.
    assert.equal(db.sql(`SELECT oid||':'||proowner||':'||proacl::text FROM pg_proc WHERE oid='${signature}'::regprocedure`), before);
    assert.equal(db.sql("SELECT pg_get_functiondef('public.capture_sms_inbound(text,text,text,text,text)'::regprocedure)"), fiveBefore);
    const reply = capture(70, "Hello");
    assert.equal(reply.kind, "reply");
    assert.equal(reply.player_id, player);
    assert.ok(reply.processed_at);
    assert.equal(reply.processing_error, null);
    assert.ok(reply.message_id);
    assert.equal(db.sql("SELECT count(*) FROM conversations"), "1", "first reply creates a conversation using production defaults");
    // opened_at, not updated_at, wins; equal opened_at uses id DESC.
    const older = "00000000-0000-4000-8000-000000000088";
    const newer = "00000000-0000-4000-8000-000000000089";
    db.sql(`UPDATE conversations SET updated_at='2100-01-01';
      INSERT INTO conversations(id,club_id,player_id,opened_at) VALUES
      ('${older}','${club}','${player}','2030-01-01'),
      ('${newer}','${club}','${player}','2030-01-01');`);
    const stop = capture(71, "STOP");
    assert.equal(stop.kind, "stop");
    assert.ok(stop.optout_event_id);
    assert.equal(stop.processing_error, null);
    assert.equal(db.sql(`SELECT conversation_id FROM messages WHERE id='${stop.message_id}'`), newer);
    assert.equal(db.sql(`SELECT opted_out AND NOT sms_opt_in FROM players WHERE id='${player}'`), "t");
    assert.equal(capture(71, "STOP").duplicate, true);
    assert.equal(db.sql("SELECT count(*) FROM sms_optout_events"), "1");
    const start = capture(72, "START");
    assert.equal(start.kind, "start");
    assert.equal(start.processing_error, null);
    assert.ok(start.processed_at);
    assert.equal(db.sql(`SELECT sms_opt_in AND NOT opted_out FROM players WHERE id='${player}'`), "t");
    assert.equal(db.sql("SELECT count(*) FROM messages WHERE direction='inbound'"), "3");
    assert.equal(db.sql("SELECT count(*) FROM messages WHERE direction='outbound'"), "0");
    assert.equal(db.sql("SELECT count(*) FROM retention_sequences"), "0");
  } finally {
    db.close();
  }
});

test("manual verification script uses the zero SID and rolls every effect back", () => {
  const db = optOutWebhookPostgres(true);
  try {
    db.sql(`INSERT INTO players(id,club_id,name,phone,notes,opted_out,sms_opt_in)
      VALUES('00000000-0000-4000-8000-000000000073','00000000-0000-4000-8000-000000000001',
      'Synthetic rollback fixture','+12013783810','[TEST_PLAYER]',false,false);`);
    const script = readFileSync(new URL("../../../verification/028_inbound_rollback.sql", import.meta.url), "utf8");
    db.sql(script);
    assert.equal(db.sql("SELECT count(*) FROM sms_inbound_receipts"), "0");
    assert.equal(db.sql("SELECT count(*) FROM sms_optout_events"), "0");
    assert.equal(db.sql("SELECT count(*) FROM messages"), "0");
    assert.equal(db.sql("SELECT count(*) FROM conversations"), "0");
    assert.equal(db.sql("SELECT is_test AND NOT opted_out AND NOT sms_opt_in FROM players"), "t");
  } finally {
    db.close();
  }
});

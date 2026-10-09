import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { operatorPostgresFixture } from "./fixtures/operatorPostgres";
import { conversationsTableSql } from "./fixtures/conversationsSchema";

test("isolated PostgreSQL inbox: unknown/STOP, scoped unique match, pause, retry, failure durability and privacy", async () => {
  const { sql, connection, close } = operatorPostgresFixture();
  const club = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  const player = "00000000-0000-4000-8000-000000000010";
  const to = "+15557654321";
  const sid = (n: number) => `SM${n.toString(16).padStart(32,"0")}`;
  const capture = (n: number, from: string, body: string, slug="pb-club") =>
    `SELECT capture_sms_inbound('${slug}','${from}','${to}','${sid(n)}','${body}',NULL::text)`;
  const get = (n: number, from: string, body: string) => JSON.parse(sql(capture(n,from,body)));
  try {
    sql(`
      CREATE TABLE players(id uuid PRIMARY KEY,club_id uuid REFERENCES clubs(id),phone text,sms_opt_in boolean DEFAULT true,opted_out boolean DEFAULT false);
      ${conversationsTableSql}
      CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),player_id uuid REFERENCES players(id),conversation_id uuid REFERENCES conversations(id),body text,direction text,sent_by text,status text,twilio_message_sid text,sent_at timestamptz,dispatch_claimed_at timestamptz,dispatch_token uuid,error_message text);
      CREATE TABLE retention_sequences(club_id uuid,player_id uuid,playbook_key text,sequence_status text);
      CREATE TABLE fixture_failure(enabled boolean); INSERT INTO fixture_failure VALUES(false);
      CREATE FUNCTION retention_sequence_transition(uuid,uuid,text,text,text,text) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT enabled FROM fixture_failure) THEN RAISE EXCEPTION 'Synthetic processing failure'; END IF;
        UPDATE retention_sequences SET sequence_status=$4 WHERE club_id=$1 AND player_id=$2 AND playbook_key=$3;
        RETURN jsonb_build_object('sequence_status',$4);
      END $$;
      INSERT INTO clubs VALUES('${other}','other-club',false);
    `);
    const migration = readFileSync(new URL("../../../migrations/021_sms_inbound_receipts.sql",import.meta.url),"utf8");
    sql(migration); sql(migration);
    // Install only the native receipt/event additions needed by the corrected
    // six-argument function; this fixture still owns its failure-injection RPC.
    const reports = readFileSync(new URL("../../../migrations/022_retention_reports_and_optouts.sql", import.meta.url), "utf8");
    const events = reports.match(/CREATE TABLE IF NOT EXISTS public\.sms_optout_events \([\s\S]*?\n\);/)?.[0];
    assert.ok(events);
    sql("ALTER TABLE sms_inbound_receipts ADD COLUMN twilio_optout_type text;");
    sql(events);
    sql(readFileSync(new URL("../../../migrations/028_inbound_conversation_order.sql", import.meta.url), "utf8"));
    const unknown = get(1,"+15550000111","Hi");
    assert.equal(unknown.player_id,null); assert.equal(unknown.match_reason,"unknown");
    assert.equal(unknown.club_id,club); assert.equal(unknown.body,"Hi"); assert.ok(unknown.processed_at);
    const stop = get(2,"+15550000222","STOP");
    assert.equal(stop.kind,"stop"); assert.equal(stop.from_phone,"+15550000222");
    assert.equal(stop.player_id,null); assert.equal(sql("SELECT count(*) FROM messages"),"0");
    sql(`INSERT INTO players(id,club_id,phone) VALUES('${player}','${club}','(555) 000-0333');
      INSERT INTO retention_sequences VALUES('${club}','${player}','ltp_followup','active');`);
    const known = get(3,"+15550000333","Hi");
    assert.equal(known.player_id,player); assert.ok(known.message_id);
    assert.equal(sql("SELECT sequence_status FROM retention_sequences"),"paused_reply");
    assert.equal(sql(`SELECT twilio_message_sid FROM messages WHERE id='${known.message_id}'`),sid(3));
    const repeats = Array.from({length:5}, () => promisify(execFile)("psql",[...connection,"-At","-c",capture(3,"+15550000333","Hi")]));
    assert.ok((await Promise.all(repeats)).every(r => JSON.parse(r.stdout).duplicate === true));
    assert.equal(sql("SELECT count(*) FROM messages"),"1");
    sql(`INSERT INTO messages(player_id,status) VALUES('${player}','pending');
      INSERT INTO messages(player_id,status,dispatch_token) VALUES('${player}','pending',gen_random_uuid());`);
    get(4,"+15550000333","STOP");
    assert.equal(sql(`SELECT opted_out AND NOT sms_opt_in FROM players WHERE id='${player}'`),"t");
    assert.equal(sql("SELECT sequence_status FROM retention_sequences"),"exited_opt_out");
    assert.equal(sql("SELECT count(*) FROM messages WHERE status='skipped'"),"1");
    assert.equal(sql("SELECT count(*) FROM messages WHERE status='pending' AND dispatch_token IS NOT NULL"),"1");
    sql(`INSERT INTO players(id,club_id,phone) VALUES
      ('00000000-0000-4000-8000-000000000011','${club}','5550000333'),
      ('00000000-0000-4000-8000-000000000012','${other}','+15550000444');`);
    const ambiguous = get(5,"+15550000333","Hi");
    assert.equal(ambiguous.player_id,null); assert.equal(ambiguous.match_reason,"ambiguous");
    assert.equal(ambiguous.message_id,null); assert.equal(ambiguous.operator_alert_attempted_at,null);
    assert.equal(get(6,"+15550000444","Hi").player_id,null,"must not match another club");
    sql(`DELETE FROM players WHERE id='00000000-0000-4000-8000-000000000011';
      UPDATE retention_sequences SET sequence_status='active'; UPDATE fixture_failure SET enabled=true;`);
    const failed = get(7,"+15550000333","Reply despite processing failure");
    assert.ok(failed.processing_error); assert.equal(failed.processed_at,null); assert.ok(failed.message_id);
    assert.equal(sql("SELECT sequence_status FROM retention_sequences"),"active");
    sql("UPDATE fixture_failure SET enabled=false");
    const retried = get(7,"+15550000333","Reply despite processing failure");
    assert.equal(retried.id,failed.id); assert.equal(retried.message_id,failed.message_id);
    assert.equal(retried.processing_error,null); assert.ok(retried.processed_at);
    assert.equal(sql("SELECT sequence_status FROM retention_sequences"),"paused_reply");
    const forbidden = spawnSync("psql",[...connection,"-c","SET ROLE anon; SELECT * FROM sms_inbound_receipts"],{encoding:"utf8"});
    assert.notEqual(forbidden.status,0); assert.match(forbidden.stderr,/permission denied/);
    const conflict = spawnSync("psql",[...connection,"-c",capture(1,"+15550000111","Hi","other-club")],{encoding:"utf8"});
    assert.notEqual(conflict.status,0); assert.match(conflict.stderr,/payload conflict/);
    assert.equal(sql(`SELECT sms_kill_switch FROM clubs WHERE id='${club}'`),"t","no sending settings changed");
  } finally { close(); }
});

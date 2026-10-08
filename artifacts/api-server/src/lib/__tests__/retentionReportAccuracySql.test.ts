import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { operatorPostgresFixture } from "./fixtures/operatorPostgres";

const migration = readFileSync(new URL("../../../migrations/023_retention_report_accuracy_views.sql", import.meta.url), "utf8");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("view-only accuracy migration: windows, boundary, booking, tests, unsent, privacy and reapplication", () => {
  const db = operatorPostgresFixture();
  try {
    assert.doesNotMatch(migration, /\b(?:UPDATE|DELETE|INSERT|CREATE\s+(?:TABLE|FUNCTION)|ALTER\s+TABLE)\b/i);
    db.sql(`
      CREATE TABLE players(id uuid PRIMARY KEY,club_id uuid,name text);
      CREATE TABLE conversations(id uuid,club_id uuid,player_id uuid);
      CREATE TABLE messages(id uuid PRIMARY KEY,player_id uuid,conversation_id uuid,body text,direction text,
        approved_at timestamptz,delivery_status text,delivered_at timestamptz,sent_at timestamptz,retention_delivery_kind text);
      CREATE TABLE retention_sequences(id uuid PRIMARY KEY,club_id uuid,player_id uuid,playbook_key text,
        sequence_status text,exit_reason text,step1_sent_at timestamptz,step2_sent_at timestamptz,
        step1_message_id uuid,step2_message_id uuid,step1_delivery_kind text);
      CREATE TABLE retention_candidates(id uuid,club_id uuid,sequence_id uuid,step integer,message_id uuid,prelaunch_superseded_by uuid);
      CREATE TABLE attendances(club_id uuid,player_id uuid,event_id text,program_name text,booked_at timestamptz,coupon_code text);
      CREATE TABLE sms_inbound_receipts(club_id uuid,player_id uuid,kind text,received_at timestamptz,message_id uuid);
      CREATE TABLE sms_optouts(id uuid,club_id uuid,player_id uuid,opted_out_at timestamptz,step integer,optout_message_id uuid);
      CREATE TABLE contact_ledger(club_id uuid,message_id uuid,is_test boolean);
      CREATE TABLE retention_ltp_test_controls(club_id uuid,sequence_id uuid);
      CREATE FUNCTION retention_report_is_ltp(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS
        'SELECT lower($1) LIKE ''%learn to play%''';
      INSERT INTO players VALUES('${id(2)}','${id(1)}','Fixture');
      INSERT INTO retention_sequences(id,club_id,player_id,playbook_key,sequence_status,step1_sent_at,step2_sent_at)
      VALUES
        ('${id(10)}','${id(1)}','${id(2)}','ltp_followup','active',now()-interval '16 days',NULL),
        ('${id(11)}','${id(1)}','${id(2)}','ltp_followup','active',now()-interval '22 days',NULL),
        ('${id(12)}','${id(1)}','${id(2)}','ltp_followup','completed',now()-interval '30 days',now()-interval '13 days'),
        ('${id(13)}','${id(1)}','${id(2)}','ltp_followup','completed',now()-interval '30 days',now()-interval '15 days'),
        ('${id(14)}','${id(1)}','${id(2)}','ltp_followup','active',NULL,NULL);
      GRANT SELECT ON players,conversations,messages,retention_sequences,retention_candidates,attendances,
        sms_inbound_receipts,sms_optouts,contact_ledger,retention_ltp_test_controls TO service_role;
    `);
    db.sql(migration);
    db.sql(migration);
    const outcome = (n: number) => db.sql(`SELECT outcome FROM playbook_outcomes WHERE sequence_id='${id(n)}'`);
    assert.equal(outcome(10), "in_window", "step-one-only cannot close after 14 days");
    assert.equal(outcome(11), "no_booking");
    assert.equal(outcome(12), "in_window", "late step two extends the window");
    assert.equal(outcome(13), "no_booking");
    assert.equal(outcome(14), "", "unsent drafts cannot enter the closed denominator");
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes WHERE outcome IN ('booked','no_booking')"), "2");
    assert.match(db.sql(`BEGIN; UPDATE retention_sequences SET step1_sent_at=now()-interval '21 days'
      WHERE id='${id(10)}'; SELECT outcome FROM playbook_outcomes WHERE sequence_id='${id(10)}'; ROLLBACK;`), /\bin_window\b/);
    db.sql(`INSERT INTO attendances VALUES('${id(1)}','${id(2)}','ltp','Learn to Play',now()-interval '5 days',NULL),
      ('${id(1)}','${id(2)}','booking','Open Play',now()-interval '1 day','NEXT25')`);
    assert.equal(outcome(10), "booked", "booking in day 15–21 counts; LTP booking is skipped");
    assert.equal(db.sql(`SELECT booked_event_id||':'||coupon_code_used FROM playbook_outcomes WHERE sequence_id='${id(10)}'`), "booking:NEXT25");
    db.sql(`UPDATE retention_sequences SET step1_delivery_kind='test' WHERE id='${id(10)}';
      INSERT INTO messages(id,retention_delivery_kind) VALUES('${id(30)}','test');
      UPDATE retention_sequences SET step1_message_id='${id(30)}' WHERE id='${id(11)}';
      INSERT INTO contact_ledger VALUES('${id(1)}','${id(31)}',true);
      UPDATE retention_sequences SET step2_message_id='${id(31)}' WHERE id='${id(12)}';
      INSERT INTO retention_ltp_test_controls VALUES('${id(1)}','${id(13)}');`);
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes"), "0");
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes_audit WHERE is_test"), "4");
    assert.equal(db.sql("SELECT count(*) FROM retention_sequences"), "5", "nothing deleted or rewritten by views");
    assert.equal(db.sql("SELECT has_table_privilege('anon','playbook_outcomes_audit','SELECT') OR has_table_privilege('authenticated','playbook_outcomes','SELECT')"), "f");
    assert.match(db.sql("SET ROLE service_role; SELECT count(*) FROM playbook_outcomes_audit; RESET ROLE;"), /\b5\b/);
  } finally { db.close(); }
});

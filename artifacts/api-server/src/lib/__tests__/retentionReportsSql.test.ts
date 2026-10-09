import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { operatorPostgresFixture } from "./fixtures/operatorPostgres";
import { isLearnToPlayName } from "../retentionContext";
import { conversationsTableSql } from "./fixtures/conversationsSchema";

const migration = readFileSync(new URL("../../../migrations/022_retention_reports_and_optouts.sql", import.meta.url), "utf8");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";

test("report migration: real SQL, backfills, attribution, LTP parity, receipt retries and private grants", () => {
  const db = operatorPostgresFixture();
  try {
    db.sql(`
      CREATE TABLE players(id uuid PRIMARY KEY,club_id uuid,name text,phone text,opted_out boolean DEFAULT false,sms_opt_in boolean DEFAULT true);
      ${conversationsTableSql}
      CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),player_id uuid,conversation_id uuid,body text,direction text,
        sent_by text,status text,twilio_message_sid text,sent_at timestamptz DEFAULT now(),error_code text,error_message text,
        approved_at timestamptz,delivery_status text,delivered_at timestamptz,dispatch_claimed_at timestamptz,dispatch_token uuid);
      CREATE TABLE retention_sequences(id uuid PRIMARY KEY,club_id uuid,player_id uuid,playbook_key text,sequence_status text,
        exit_reason text,step1_sent_at timestamptz,step2_sent_at timestamptz,step1_message_id uuid,step2_message_id uuid);
      CREATE TABLE retention_candidates(id uuid PRIMARY KEY,club_id uuid,player_id uuid,sequence_id uuid,playbook_key text,
        step smallint,message_id uuid,prelaunch_superseded_by uuid);
      CREATE TABLE attendances(player_id uuid,club_id uuid,event_id text,program_name text,attended_at timestamptz,booked_at timestamptz,coupon_code text);
      CREATE TABLE sms_inbound_receipts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,player_id uuid,message_id uuid,
        twilio_message_sid text UNIQUE,from_phone text,to_phone text,body text,kind text,match_reason text,received_at timestamptz DEFAULT now(),
        processed_at timestamptz,processing_error text,operator_alert_attempted_at timestamptz);
      CREATE FUNCTION retention_sequence_transition(uuid,uuid,text,text,text,text) RETURNS void LANGUAGE sql AS 'SELECT';
      INSERT INTO players(id,club_id,name,phone,opted_out) VALUES
        ('${id(2)}','${id(1)}','Report Player','+12015550002',true),
        ('${id(3)}','${id(1)}','Carrier Player','+12015550003',true),
        ('${id(4)}','${id(1)}','Unknown Time Player','+12015550004',true),
        ('${id(5)}','${id(1)}','New STOP Player','+12015550005',false),
        ('${id(6)}','${id(1)}','Older LTP Player','+12015550006',false);
      INSERT INTO messages(id,player_id,body,direction,status,sent_at,approved_at,delivery_status) VALUES
        ('${id(11)}','${id(2)}','First text','outbound','sent','2026-05-01','2026-04-30','delivered'),
        ('${id(12)}','${id(2)}','Second text','outbound','sent','2026-05-10','2026-05-09','sent'),
        ('${id(13)}','${id(2)}','Draft is not a sent text','outbound','pending','2026-05-11',null,null),
        ('${id(14)}','${id(5)}','New member invitation','outbound','sent','2026-05-01',null,'delivered');
      INSERT INTO messages(id,player_id,body,direction,status,sent_at,error_code,twilio_message_sid)
        VALUES('${id(15)}','${id(3)}','Carrier blocked','outbound','undelivered','2026-05-01','21610','SM11111111111111111111111111111111');
      INSERT INTO retention_sequences VALUES('${id(20)}','${id(1)}','${id(2)}','ltp_followup','completed',null,
        '2026-05-01','2026-05-10','${id(11)}','${id(12)}');
      INSERT INTO retention_candidates VALUES
        ('${id(21)}','${id(1)}','${id(2)}','${id(20)}','ltp_followup',1,'${id(11)}',null),
        ('${id(22)}','${id(1)}','${id(2)}','${id(20)}','ltp_followup',2,'${id(12)}',null),
        ('${id(23)}','${id(1)}','${id(2)}','${id(20)}','ltp_followup',1,'${id(13)}','${id(21)}');
      INSERT INTO attendances VALUES
        ('${id(2)}','${id(1)}','ltp1','Learn—To_Play','2026-04-30','2026-04-20',null),
        ('${id(2)}','${id(1)}','ltp2','LEARN TO PLAY','2026-05-05','2026-05-02',null),
        ('${id(2)}','${id(1)}','booked1','Open Play','2026-05-20','2026-05-11','NEXT25'),
        ('${id(2)}','${id(1)}','late','Clinic','2026-07-01','2026-06-01',null),
        ('${id(5)}','${id(1)}','ltp3','Learn to Play','2026-06-01','2026-05-20',null),
        ('${id(6)}','${id(1)}','old','Learn to Play','2026-01-01','2025-12-01',null),
        ('${id(6)}','${id(1)}','repeat','Learn to Play','2026-06-01','2026-05-20',null);
      INSERT INTO sms_inbound_receipts(id,club_id,player_id,twilio_message_sid,from_phone,to_phone,body,kind,match_reason,received_at,processed_at)
        VALUES('${id(30)}','${id(1)}','${id(2)}','SM22222222222222222222222222222222','+12015550002','+12015559999',
          'STOP','stop','matched','2026-05-12','2026-05-12');
      GRANT SELECT ON players,messages,conversations,attendances,retention_sequences,retention_candidates TO service_role;
    `);
    db.sql(migration);
    db.sql(readFileSync(new URL("../../../migrations/028_inbound_conversation_order.sql", import.meta.url), "utf8"));
    assert.equal(db.sql("SELECT string_agg(source||':'||n,',' ORDER BY source) FROM (SELECT source,count(*) n FROM sms_optout_events GROUP BY source)t"),
      "carrier_21610:1,manual:1,stop_reply:1");
    assert.equal(db.sql("SELECT count(*) FROM sms_optout_events WHERE alerted_at IS NOT NULL"), "0");
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes"), "1", "superseded drafts must not duplicate sequences");
    assert.equal(db.sql(`SELECT booked_event_id||':'||credited_step||':'||step1_delivered||':'||step2_delivered||':'||optout_after_step
      FROM playbook_outcomes`), "booked1:2:true:false:2");
    assert.equal(db.sql("SELECT body FROM sms_optouts WHERE event_source='stop_reply'"), "Second text", "ignore legacy draft timestamps");
    assert.equal(db.sql("SELECT count(*) FROM sms_optouts WHERE source='unattributed'"), "2", "unknown callback/manual times must stay unattributed");
    assert.equal(db.sql("SELECT n_players||':'||n_booked||':'||(rate=0.5) FROM ltp_baseline"), "2:1:true");
    const names = ["Learn to Play", "LEARN_to_PLAY", "Learn—To—Play", "Learn   to\tPlay", "ＬＥＡＲＮ　ＴＯ　ＰＬＡＹ",
      "xlearn to play", "Learn to player", "Intro: Learn-to-Play!", "Learn to Playfulness", "learn to play_foo", "", "Learn\u00a0to\u00a0Play"];
    for (const name of names) {
      assert.equal(db.sql(`SELECT retention_report_is_ltp(${literal(name)})`), isLearnToPlayName(name) ? "t" : "f", name);
    }
    const incoming = `capture_sms_inbound('pb-club','+12015550005','+12015559999',
      'SM33333333333333333333333333333333','Please stop messaging me','STOP')`;
    const first = JSON.parse(db.sql(`SELECT ${incoming}`));
    assert.equal(first.kind, "stop");
    assert.equal(first.twilio_optout_type, "STOP");
    assert.equal(first.optout_type_mismatch, true);
    assert.equal(first.optout_event_created, true);
    assert.equal(db.sql(`SELECT opted_out AND NOT sms_opt_in FROM players WHERE id='${id(5)}'`), "t");
    const replay = JSON.parse(db.sql(`SELECT ${incoming}`));
    assert.equal(replay.optout_event_id, first.optout_event_id);
    assert.equal(replay.optout_event_created, false);
    assert.equal(replay.duplicate, true);
    assert.equal(db.sql("SELECT count(*) FROM sms_optout_events"), "4");
    const unknown = JSON.parse(db.sql(`SELECT capture_sms_inbound('pb-club','+12015558888','+12015559999',
      'SM44444444444444444444444444444444','STOP','STOP')`));
    assert.equal(unknown.player_id, null);
    assert.ok(unknown.optout_event_id, "unknown STOP still needs its own event");
    assert.equal(db.sql("SELECT bool_and(is_backfill) FROM sms_optout_events WHERE inbound_receipt_id='" + id(30) + "'"), "t");
    db.sql(migration);
    assert.equal(db.sql("SELECT count(*) FROM sms_optout_events"), "5", "reapplying must not add backfills");
    assert.equal(db.sql("SELECT has_table_privilege('anon','sms_optouts','SELECT') OR has_table_privilege('authenticated','playbook_outcomes','SELECT')"), "f");
    assert.equal(db.sql("SELECT relrowsecurity FROM pg_class WHERE oid='sms_optout_events'::regclass"), "t");
    assert.equal(db.sql("SET ROLE service_role; SELECT count(*) FROM playbook_outcomes; RESET ROLE;").includes("1"), true);
  } finally { db.close(); }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { operatorPostgresFixture } from "./fixtures/operatorPostgres";

test("025 archives history and terminally closes roots/candidates without changing reports, messages or uniqueness", () => {
  const db = operatorPostgresFixture();
  const load = (name: string) => readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
  const migration = load("025_retention_test_history_recovery.sql");
  const entries = JSON.parse(migration.match(/jsonb_array_elements\('([\s\S]*?)'::jsonb\)/)![1]);
  try {
    db.sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    db.sql(readFileSync(new URL("./sql/ltpTestTools.fixture.sql", import.meta.url), "utf8").replace(/CREATE ROLE \w+;\n/g, ""));
    db.sql(`
      ALTER TABLE clubs ADD COLUMN slug text;
      ALTER TABLE players ADD COLUMN name text;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id uuid, ADD COLUMN IF NOT EXISTS direction text;
      ALTER TABLE retention_candidates ADD COLUMN prelaunch_superseded_by uuid;
      ALTER TABLE attendances ADD COLUMN club_id uuid,ADD COLUMN program_name text,
        ADD COLUMN booked_at timestamptz,ADD COLUMN coupon_code text;
      CREATE TABLE conversations(id uuid,club_id uuid,player_id uuid);
      CREATE TABLE sms_inbound_receipts(club_id uuid,player_id uuid,kind text,received_at timestamptz,message_id uuid);
      CREATE TABLE sms_optouts(id uuid,club_id uuid,player_id uuid,opted_out_at timestamptz,step integer,optout_message_id uuid);
      CREATE TABLE retention_ltp_test_controls(sequence_id uuid PRIMARY KEY,club_id uuid,simulated_booking boolean);
      ALTER TABLE contact_ledger ADD COLUMN club_id uuid;
      CREATE FUNCTION retention_report_is_ltp(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT false';
      CREATE UNIQUE INDEX retention_candidates_player_playbook_step_unique
        ON retention_candidates(player_id,playbook_key,step) WHERE prelaunch_superseded_by IS NULL;
      ALTER TABLE retention_sequences ADD CONSTRAINT retention_sequences_sequence_status_check
        CHECK (sequence_status IN ('active','paused_reply','exited_booked','exited_opt_out','completed'));
      ALTER TABLE retention_candidates ADD CONSTRAINT retention_candidates_sequence_status_check
        CHECK (sequence_status IN ('active','paused_reply','exited_booked','exited_opt_out','completed'));
      INSERT INTO clubs VALUES('00000000-0000-4000-8000-000000000001','pb-club');
    `);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const player = `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
      db.sql(`INSERT INTO players(id,club_id,name) VALUES('${player}','00000000-0000-4000-8000-000000000001','Synthetic ${index}');
        INSERT INTO retention_sequences(id,club_id,player_id,playbook_key,trigger_event_id,step1_sent_at,step1_message_id,step1_delivery_kind)
        VALUES('${entry.sequence_id}','00000000-0000-4000-8000-000000000001','${player}','ltp_followup','trigger',now()-interval '2 days','${entry.step1}','test');`);
      for (let step = 0; step < entry.destinations.length; step++) {
        const dest = entry.destinations[step];
        db.sql(`INSERT INTO messages(id,player_id,status,sent_at,retention_delivery_kind,twilio_message_sid)
          VALUES('${dest.message_id}','${player}','sent',now()-interval '2 days','test','${dest.twilio_message_sid}');
          INSERT INTO retention_candidates(id,club_id,player_id,playbook_key,trigger_event_id,sequence_id,step,status,message_id,context)
          VALUES(gen_random_uuid(),'00000000-0000-4000-8000-000000000001','${player}','ltp_followup','trigger','${entry.sequence_id}',${step + 1},'sent','${dest.message_id}',
            jsonb_build_object('trigger',jsonb_build_object('date',now()-interval '60 days')));
          INSERT INTO contact_ledger(club_id,message_id,is_test,intended_player_id) VALUES('00000000-0000-4000-8000-000000000001','${dest.message_id}',true,'${player}');`);
        if (step === 1) db.sql(`UPDATE retention_sequences SET step2_sent_at=now()-interval '1 day',step2_message_id='${dest.message_id}' WHERE id='${entry.sequence_id}';`);
      }
    }
    // A test-simulated booking must not be mistaken for a genuine return.
    db.sql(`UPDATE retention_sequences SET sequence_status='exited_booked',exit_reason='test_simulated_booking_at_dispatch',
      booked_event_id='test-simulated-booking' WHERE id='${entries[2].sequence_id}';`);
    for (let index = 0; index < 3; index++) {
      const player = `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;
      db.sql(`INSERT INTO players(id,club_id,name) VALUES('${player}','00000000-0000-4000-8000-000000000001','Real cohort fixture');
        INSERT INTO retention_sequences(club_id,player_id,playbook_key,trigger_event_id,step1_sent_at,step1_delivery_kind)
        VALUES('00000000-0000-4000-8000-000000000001','${player}','ltp_followup','real-trigger',now()-interval '1 day','real');`);
    }
    db.sql(load("023_retention_report_accuracy_views.sql"));
    db.sql(load("024_retention_test_history_and_unsent_audit.sql"));
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes"), "3");
    const beforeMessages = db.sql("SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM messages m");
    const beforeUniqueness = db.sql("SELECT string_agg(indexdef,E'\\n' ORDER BY indexname) FROM pg_indexes WHERE tablename IN ('retention_sequences','retention_candidates')");
    const beforeCandidateIds = db.sql("SELECT string_agg(id::text,',' ORDER BY id) FROM retention_candidates");
    const sequenceSource = load("013_retention_ltp_sequence.sql");
    db.sql(sequenceSource.match(/CREATE OR REPLACE FUNCTION public\.retention_sequence_transition\([\s\S]*?END \$\$;/)![0]);
    db.sql(`SET app.retention_recovery_live_checked_at='${new Date().toISOString()}'; SET app.retention_recovery_operator='Fixture operator'; ${migration}`);
    assert.equal(db.sql("SELECT count(*) FROM retention_test_history"), "4");
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes"), "3");
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes_audit WHERE sequence_status='exited_test' AND is_test AND NOT booked"), "4");
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes WHERE sequence_status='exited_test'"), "0");
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes_audit WHERE is_test"), "8");
    assert.equal(db.sql("SELECT count(*) FROM retention_sequences"), "7");
    assert.equal(db.sql("SELECT string_agg(id::text,',' ORDER BY id) FROM retention_candidates"), beforeCandidateIds);
    assert.equal(db.sql("SELECT count(*) FROM retention_candidates WHERE status<>'skipped' OR sequence_status<>'exited_test' OR booked_event_id IS NOT NULL OR exit_reason<>'test_override_sends' OR context->>'already_booked'<>'false' OR context->'booked_event'<>'null'::jsonb"), "0");
    db.sql(`DO $test$ DECLARE r record; refused boolean;
      BEGIN
        FOR r IN SELECT * FROM retention_sequences WHERE sequence_status='exited_test' LOOP
          refused:=false;
          BEGIN PERFORM retention_sequence_transition(r.club_id,r.player_id,'ltp_followup','exited_booked','booked_after_ltp','real-booking');
          EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
          IF NOT refused THEN RAISE EXCEPTION 'Terminal root became booked'; END IF;
          refused:=false;
          BEGIN UPDATE retention_sequences SET sequence_status='active' WHERE id=r.id;
          EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
          IF NOT refused THEN RAISE EXCEPTION 'Terminal root reactivated'; END IF;
          refused:=false;
          BEGIN UPDATE retention_candidates SET status='drafted' WHERE sequence_id=r.id;
          EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
          IF NOT refused THEN RAISE EXCEPTION 'Terminal candidate became dispatchable'; END IF;
          refused:=false;
          BEGIN UPDATE retention_candidates SET context=context || '{"already_booked":true,"booked_event":{"id":"booking"}}'::jsonb WHERE sequence_id=r.id;
          EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
          IF NOT refused THEN RAISE EXCEPTION 'Terminal candidate acquired booked flags'; END IF;
        END LOOP;
      END $test$;`);
    assert.equal(db.sql("SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM messages m"), beforeMessages);
    assert.equal(db.sql("SELECT string_agg(indexdef,E'\\n' ORDER BY indexname) FROM pg_indexes WHERE tablename IN ('retention_sequences','retention_candidates')"), beforeUniqueness);
    assert.equal(db.sql("SELECT has_table_privilege('anon','retention_test_history','SELECT') OR has_table_privilege('authenticated','retention_test_history','SELECT')"), "f");
    assert.equal(db.sql("SELECT count(*) FROM retention_test_history WHERE jsonb_array_length(message_destinations)>0 AND jsonb_array_length(candidates_snapshot)>0 AND report_snapshot->>'is_test'='true'"), "4");
    db.sql(`SET app.retention_recovery_live_checked_at='${new Date().toISOString()}'; SET app.retention_recovery_operator='Fixture operator'; ${migration}`);
    assert.equal(db.sql("SELECT count(*) FROM retention_test_history"), "4", "retry does not archive/close twice");
  } finally { db.close(); }
});

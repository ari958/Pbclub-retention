import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { operatorPostgresFixture } from "./fixtures/operatorPostgres";

test("025 minimal terminal close: isolated PostgreSQL verification", async (t) => {
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
      for (const unsentId of entry.unsent_message_ids ?? []) {
        db.sql(`INSERT INTO messages(id,player_id,status,sent_at) VALUES('${unsentId}','${player}','archived',NULL);
          INSERT INTO retention_candidates(id,club_id,player_id,playbook_key,trigger_event_id,sequence_id,step,status,message_id,context)
          VALUES(gen_random_uuid(),'00000000-0000-4000-8000-000000000001','${player}','ltp_followup','trigger',
            '${entry.sequence_id}',2,'skipped','${unsentId}','{"already_booked":false,"booked_event":null}');`);
      }
      db.sql(`UPDATE retention_sequences SET sequence_status='${entry.sequence_status}',
        booked_event_id=${entry.booked_event_id ? `'${entry.booked_event_id}'` : "NULL"}
        WHERE id='${entry.sequence_id}';
        INSERT INTO retention_ltp_test_controls(sequence_id,club_id,simulated_booking)
        VALUES('${entry.sequence_id}','00000000-0000-4000-8000-000000000001',false);
        INSERT INTO retention_capacity_reservations(candidate_id,club_id,sequence_id,event_id)
        SELECT id,club_id,sequence_id,'reserved-fixture' FROM retention_candidates WHERE sequence_id='${entry.sequence_id}';`);
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
    const beforeLedger = db.sql("SELECT jsonb_agg(to_jsonb(l) ORDER BY message_id) FROM contact_ledger l");
    const beforeUniqueness = db.sql("SELECT string_agg(indexdef,E'\\n' ORDER BY indexname) FROM pg_indexes WHERE tablename IN ('retention_sequences','retention_candidates')");
    const beforeCandidateIds = db.sql("SELECT string_agg(id::text,',' ORDER BY id) FROM retention_candidates");
    const viewDefinitions = () => db.sql("SELECT string_agg(pg_get_viewdef(oid,true),E'\\n' ORDER BY relname) FROM pg_class WHERE relname IN ('playbook_outcomes','playbook_outcomes_audit')");
    const beforeViews = viewDefinitions();
    const snapshot = () => {
      const tables = ["clubs", "players", "messages", "retention_sequences", "retention_candidates",
        "contact_ledger", "retention_capacity_reservations", "retention_ltp_test_controls", "attendances",
        "sms_inbound_receipts", "sms_optouts", "conversations"];
      if (db.sql("SELECT to_regclass('public.retention_test_history') IS NOT NULL") === "t") tables.push("retention_test_history");
      return JSON.stringify({
        rows: tables.map(name => [name, db.sql(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') FROM public.${name} r`)]),
        views: viewDefinitions(),
        guards: db.sql("SELECT string_agg(pg_get_functiondef(oid),E'\\n' ORDER BY proname) FROM pg_proc WHERE proname LIKE 'retention_preserve_test_terminal_%'"),
        constraints: db.sql("SELECT string_agg(pg_get_constraintdef(oid),E'\\n' ORDER BY conname) FROM pg_constraint WHERE conname IN ('retention_sequences_sequence_status_check','retention_candidates_sequence_status_check')"),
      });
    };
    const sequenceSource = load("013_retention_ltp_sequence.sql");
    db.sql(sequenceSource.match(/CREATE OR REPLACE FUNCTION public\.retention_sequence_transition\([\s\S]*?END \$\$;/)![0]);
    await t.test("unsafe state, destination and linked-message inputs raise and roll back everything", () => {
      const joe = entries[3];
      const ke = entries[2];
      const destination = joe.destinations[1];
      const extraId = "00000000-0000-4000-8000-000000009999";
      const cases = [
        {
          name: "SID mismatch on the last sequence rolls back the first three closes",
          change: `UPDATE messages SET twilio_message_sid='SMmismatch' WHERE id='${destination.message_id}'`,
          restore: `UPDATE messages SET twilio_message_sid='${destination.twilio_message_sid}' WHERE id='${destination.message_id}'`,
          error: /Recovery destination proof/,
        },
        {
          name: "archived status cannot hide a SID mismatch even without sent_at",
          change: `UPDATE messages SET status='archived',sent_at=NULL,twilio_message_sid='SMmismatch' WHERE id='${destination.message_id}'`,
          restore: `UPDATE messages SET status='sent',sent_at=(SELECT step2_sent_at FROM retention_sequences WHERE id='${joe.sequence_id}')-interval '1 day',twilio_message_sid='${destination.twilio_message_sid}' WHERE id='${destination.message_id}'`,
          error: /Recovery destination proof/,
        },
        {
          name: "sent_at without SID fails closed",
          change: `UPDATE messages SET twilio_message_sid=NULL WHERE id='${destination.message_id}'`,
          restore: `UPDATE messages SET twilio_message_sid='${destination.twilio_message_sid}' WHERE id='${destination.message_id}'`,
          error: /Recovery destination proof/,
        },
        {
          name: "a listed send cannot lose both its SID and sent_at",
          change: `UPDATE messages SET twilio_message_sid=NULL,sent_at=NULL WHERE id='${destination.message_id}'`,
          restore: `UPDATE messages SET twilio_message_sid='${destination.twilio_message_sid}' WHERE id='${destination.message_id}'`,
          error: /Recovery destination proof/,
        },
        {
          name: "Ke's expected unsent message cannot gain unlisted provider evidence",
          change: `UPDATE messages SET twilio_message_sid='${destination.twilio_message_sid}' WHERE id='${ke.unsent_message_ids[0]}'`,
          restore: `UPDATE messages SET twilio_message_sid=NULL WHERE id='${ke.unsent_message_ids[0]}'`,
          error: /Recovery destination proof/,
        },
        {
          name: "a linked message row cannot be missing",
          change: `DELETE FROM messages WHERE id='${ke.unsent_message_ids[0]}'`,
          restore: `INSERT INTO messages(id,player_id,status,sent_at) SELECT '${ke.unsent_message_ids[0]}',player_id,'archived',NULL FROM retention_sequences WHERE id='${ke.sequence_id}'`,
          error: /Recovery linked-message set/,
        },
        {
          name: "an expected link cannot be missing",
          change: `UPDATE retention_candidates SET message_id=NULL WHERE message_id='${ke.unsent_message_ids[0]}'`,
          restore: `UPDATE retention_candidates SET message_id='${ke.unsent_message_ids[0]}' WHERE sequence_id='${ke.sequence_id}' AND step=2`,
          error: /Recovery linked-message set/,
        },
        {
          name: "an extra unsent linked message is refused",
          change: `INSERT INTO messages(id,status) VALUES('${extraId}','archived'); UPDATE retention_candidates SET message_id='${extraId}' WHERE sequence_id='${joe.sequence_id}' AND step=2`,
          restore: `UPDATE retention_candidates SET message_id='${destination.message_id}' WHERE sequence_id='${joe.sequence_id}' AND step=2; DELETE FROM messages WHERE id='${extraId}'`,
          error: /Recovery linked-message set/,
        },
        {
          name: "unexpected sequence_status is refused",
          change: `UPDATE retention_sequences SET sequence_status='active' WHERE id='${joe.sequence_id}'`,
          restore: `UPDATE retention_sequences SET sequence_status='completed' WHERE id='${joe.sequence_id}'`,
          error: /Recovery compare-and-set/,
        },
        {
          name: "NULL sequence_status is refused",
          change: `UPDATE retention_sequences SET sequence_status=NULL WHERE id='${joe.sequence_id}'`,
          restore: `UPDATE retention_sequences SET sequence_status='completed' WHERE id='${joe.sequence_id}'`,
          error: /Recovery compare-and-set/,
        },
        {
          name: "unexpected step1_message_id is refused",
          change: `UPDATE retention_sequences SET step1_message_id='${extraId}' WHERE id='${joe.sequence_id}'`,
          restore: `UPDATE retention_sequences SET step1_message_id='${joe.step1}' WHERE id='${joe.sequence_id}'`,
          error: /Recovery identity/,
        },
        {
          name: "unexpected step2_message_id is refused",
          change: `UPDATE retention_sequences SET step2_message_id=NULL WHERE id='${joe.sequence_id}'`,
          restore: `UPDATE retention_sequences SET step2_message_id='${joe.step2}' WHERE id='${joe.sequence_id}'`,
          error: /Recovery identity/,
        },
        {
          name: "Ke's simulated-booking identity must match",
          change: `UPDATE retention_sequences SET booked_event_id='different-booking' WHERE id='${ke.sequence_id}'`,
          restore: `UPDATE retention_sequences SET booked_event_id='test-simulated-booking' WHERE id='${ke.sequence_id}'`,
          error: /Recovery compare-and-set/,
        },
      ];
      for (const scenario of cases) {
        const beforeChange = snapshot();
        const originalMessages = db.sql("SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM messages m");
        db.sql(scenario.change);
        const beforeFailure = snapshot();
        assert.throws(() => db.sql(migration), scenario.error, scenario.name);
        assert.equal(snapshot(), beforeFailure, `${scenario.name}: zero changes`);
        db.sql(scenario.restore);
        const columns = Object.keys(JSON.parse(originalMessages)[0]).filter(name => name !== "id");
        db.sql(`UPDATE messages m SET (${columns.join(",")})=(${columns.map(name => `x.${name}`).join(",")})
          FROM jsonb_populate_recordset(NULL::messages,'${originalMessages.replace(/'/g, "''")}'::jsonb) x WHERE m.id=x.id`);
        assert.equal(snapshot(), beforeChange, `${scenario.name}: fixture restored exactly`);
        console.log(`PASS: ${scenario.name}; all rows/schema definitions unchanged`);
      }
    });
    await t.test("first run closes all four; each has one is_test audit row; live outcomes stay at 3", () => {
    db.sql(migration);
    assert.equal(db.sql("SELECT count(*) FROM retention_test_history"), "4");
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes"), "3");
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes_audit WHERE sequence_status='exited_test' AND is_test AND NOT booked"), "4");
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes WHERE sequence_status='exited_test'"), "0");
    assert.equal(db.sql("SELECT count(*) FROM playbook_outcomes_audit WHERE is_test"), "4");
    assert.equal(db.sql(`SELECT count(*) FROM (SELECT sequence_id FROM playbook_outcomes_audit
      WHERE sequence_id IN (${entries.map((entry: any) => `'${entry.sequence_id}'`).join(",")})
      GROUP BY sequence_id HAVING count(*)=1 AND bool_and(is_test)) single_test_rows`), "4");
    assert.equal(db.sql("SELECT count(*) FROM retention_sequences WHERE sequence_status='exited_test' AND exit_reason='test_override_sends' AND exited_at IS NOT NULL AND booked_event_id IS NULL"), "4");
    assert.equal(db.sql("SELECT count(*) FROM retention_capacity_reservations"), "0");
    assert.equal(db.sql("SELECT count(*) FROM retention_ltp_test_controls"), "0");
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
    assert.equal(db.sql("SELECT jsonb_agg(to_jsonb(l) ORDER BY message_id) FROM contact_ledger l"), beforeLedger);
    assert.equal(viewDefinitions(), beforeViews);
    assert.equal(db.sql("SELECT string_agg(indexdef,E'\\n' ORDER BY indexname) FROM pg_indexes WHERE tablename IN ('retention_sequences','retention_candidates')"), beforeUniqueness);
    assert.equal(db.sql("SELECT has_table_privilege('anon','retention_test_history','SELECT') OR has_table_privilege('authenticated','retention_test_history','SELECT')"), "f");
    assert.equal(db.sql("SELECT count(*) FROM retention_test_history WHERE jsonb_array_length(message_destinations)>0 AND jsonb_array_length(candidates_snapshot)>0 AND report_snapshot->>'is_test'='true'"), "4");
    console.log("FIRST RUN: 4 closed, 6 retained/skipped candidates, 4 archives, 1 is_test=true audit row per target, 3 playbook_outcomes rows");
    });
    await t.test("second run leaves every application row and view definition unchanged", () => {
    assert.equal(db.sql("SELECT count(*) FROM retention_sequences WHERE sequence_status='exited_test'"), "4");
    const afterFirstRun = snapshot();
    db.sql(migration);
    assert.equal(snapshot(), afterFirstRun);
    assert.equal(db.sql("SELECT count(*) FROM retention_test_history"), "4", "retry does not archive/close twice");
    console.log("SECOND RUN: exact application-row/schema-definition snapshot unchanged");
    });
    await t.test("SID mismatch is refused even after closure, without changing anything", () => {
      assert.equal(db.sql("SELECT count(*) FROM retention_sequences WHERE sequence_status='exited_test'"), "4");
      const message = entries[3].destinations[1];
      db.sql(`UPDATE messages SET status='archived',twilio_message_sid='SMmismatch' WHERE id='${message.message_id}'`);
      const beforeFailure = snapshot();
      assert.throws(() => db.sql(migration), /Recovery destination proof/);
      assert.equal(snapshot(), beforeFailure);
      console.log("MISMATCHED SID: exception raised; exact before/after application-row/schema-definition snapshot unchanged");
    });
  } finally { db.close(); }
});

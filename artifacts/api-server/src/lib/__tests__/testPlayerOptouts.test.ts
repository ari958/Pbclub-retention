import assert from "node:assert/strict";
import { test } from "node:test";
import { optOutWebhookPostgres } from "./fixtures/optOutWebhookPostgres";
import { getTextEligibilitySkipReason, isTestPlayer } from "../retentionPolicy";
import { supabase } from "../supabaseClient";
import { recordCarrierOptOutEvent } from "../smsOptouts";

test("test player designation survives START and sync; native test events and future playbook inserts are guarded", async () => {
  const db = optOutWebhookPostgres(true);
  const originalFrom = supabase.from;
  const club = "00000000-0000-4000-8000-000000000001";
  const player = "00000000-0000-4000-8000-000000000050";
  const normal = "00000000-0000-4000-8000-000000000051";
  const sid = (n: number) => `SM${n.toString(16).padStart(32, "0")}`;
  const capture = (n: number, body: string, phone = "+15550000150", provider: string | null = null) =>
    JSON.parse(db.sql(`SELECT capture_sms_inbound('pb-club','${phone}','+15550000998','${sid(n)}',
      '${body}',${provider ? `'${provider}'` : "NULL"})`));
  try {
    db.sql(`INSERT INTO players(id,club_id,name,phone,notes,opted_out,sms_opt_in)
      VALUES('${player}','${club}','Test fixture','+15550000150','[TEST_PLAYER]',true,false),
      ('${normal}','${club}','Normal fixture','+15550000151',NULL,false,true);`);
    const start = capture(50, "START", "+15550000150", "START");
    assert.equal(start.kind, "start");
    assert.equal(start.player_id, player);
    assert.ok(start.processed_at);
    assert.equal(start.processing_error, null);
    assert.equal(db.sql(`SELECT sms_opt_in AND NOT opted_out AND is_test FROM players WHERE id='${player}'`), "t");
    assert.equal(db.sql("SELECT count(*) FROM messages WHERE direction='inbound'"), "1", "START is logged without outbound SMS");
    assert.equal(db.sql("SELECT count(*) FROM messages WHERE direction='outbound'"), "0");
    assert.equal(db.sql("SELECT count(*) FROM retention_sequences"), "0", "START creates no sequence");
    assert.equal(capture(50, "START", "+15550000150", "START").duplicate, true);
    assert.equal(db.sql("SELECT count(*) FROM messages"), "1");
    capture(51, "STOP");
    capture(52, "unsubscribe", "+15550000150", "STOP");
    assert.equal(db.sql("SELECT count(*) FROM sms_optout_events WHERE is_test"), "2");
    assert.equal(capture(51, "STOP").duplicate, true);
    assert.equal(db.sql("SELECT count(*) FROM sms_optout_events"), "2");
    capture(50, "START", "+15550000150", "START");
    assert.equal(db.sql(`SELECT opted_out FROM players WHERE id='${player}'`), "t", "old START replay cannot undo a newer STOP");
    capture(53, "START");
    assert.equal(db.sql(`SELECT sms_opt_in AND NOT opted_out AND is_test FROM players WHERE id='${player}'`), "t");
    db.sql(`UPDATE players SET notes=NULL,is_test=false WHERE id='${player}';`);
    assert.equal(db.sql(`SELECT is_test AND strpos(notes,'[TEST_PLAYER]')>0 FROM players WHERE id='${player}'`), "t");
    assert.equal(isTestPlayer({ notes: "[TEST_PLAYER]" }), true);
    assert.equal(getTextEligibilitySkipReason({ phone: "+15550000150", opted_out: false,
      sms_opt_in: true, notes: "[TEST_PLAYER]", consent_source: "web_form", sms_consented_at: new Date().toISOString() }), "test_player");
    for (const key of ["ltp_followup", "new_signup", "future_playbook"]) {
      assert.throws(() => db.sql(`INSERT INTO retention_sequences(id,club_id,player_id,playbook_key,sequence_status)
        VALUES(gen_random_uuid(),'${club}','${player}','${key}','active')`), /Test players/);
      assert.throws(() => db.sql(`INSERT INTO retention_candidates(id,club_id,player_id,playbook_key,status)
        VALUES(gen_random_uuid(),'${club}','${player}','${key}','drafted')`), /Test players/);
    }
    capture(54, "STOP", "+15550000151");
    assert.equal(db.sql("SELECT count(*) FROM sms_optouts WHERE NOT is_test"), "1");
    assert.equal(db.sql("SELECT count(*) FROM sms_optouts WHERE is_test"), "2");
    db.sql(`INSERT INTO attendances(player_id,club_id,event_id,program_name,attended_at,booked_at) VALUES
      ('${player}','${club}','test-ltp','Learn to Play','2026-08-01','2026-07-30'),
      ('${normal}','${club}','normal-ltp','Learn to Play','2026-08-01','2026-07-30'),
      ('${normal}','${club}','normal-return','Open Play','2026-08-25','2026-08-20');`);
    assert.equal(db.sql(`SELECT n_players||':'||n_booked FROM ltp_baseline WHERE club_id='${club}'`), "1:1",
      "baseline excludes test players and preserves the existing 21-day booking window");
    const message = "00000000-0000-4000-8000-000000000090";
    db.sql(`INSERT INTO messages(id,player_id,body,direction,status,sent_at,error_code)
      VALUES('${message}','${player}','Synthetic carrier fixture','outbound','undelivered',now(),'21610');`);
    supabase.from = db.from as typeof supabase.from;
    const carrierEvent = await recordCarrierOptOutEvent(player, message, new Date().toISOString());
    assert.equal(db.sql(`SELECT is_test FROM sms_optout_events WHERE id='${carrierEvent}'`), "t");
    assert.equal(await recordCarrierOptOutEvent(player, message, new Date().toISOString()), carrierEvent);
    assert.equal(db.sql("SELECT count(*) FROM sms_optout_events WHERE source='carrier_21610'"), "1");
    const unknown = capture(55, "START", "+15550000888");
    assert.equal(unknown.player_id, null);
    assert.equal(unknown.match_reason, "unknown");
    db.sql(`INSERT INTO players(id,club_id,phone) VALUES(gen_random_uuid(),'${club}','+15550000150');`);
    const ambiguous = capture(56, "START");
    assert.equal(ambiguous.player_id, null);
    assert.equal(ambiguous.match_reason, "ambiguous");
  } finally {
    supabase.from = originalFrom;
    db.close();
  }
});

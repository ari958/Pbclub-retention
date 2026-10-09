import assert from "node:assert/strict";
import { test } from "node:test";
import type { Server } from "node:http";
import { existsSync } from "node:fs";
import express from "express";
import twilio from "twilio";
import { supabase } from "../../lib/supabaseClient";
import { validateTwilioWebhook } from "../../lib/twilioWebhook";
import { setBackgroundJobsEnabledForTests } from "../../lib/backgroundPolicy";
import { setOperatorAlertTransportForTests } from "../../lib/operatorMonitoring";
import { setTwilioClientFactoryForTests } from "../../lib/twilio";
import { workerIdentity } from "../../lib/workerIdentity";
import { optOutWebhookPostgres } from "../../lib/__tests__/fixtures/optOutWebhookPostgres";
import messagesRouter from "../messages";

test("signed STOP, provider STOP classification and 21610: one event/alert each, replay deduplication and cleanup", async () => {
  assert.equal(process.env.NODE_ENV, "test", "Never run this fixture on a live server");
  const originalFrom = supabase.from, originalRpc = supabase.rpc;
  const keys = ["PUBLIC_API_URL", "TWILIO_AUTH_TOKEN", "ALERT_OPERATOR_TO", "TWILIO_PHONE_NUMBER"] as const;
  // The runner removes inherited Twilio/alert credentials before this process.
  for (const key of keys) assert.equal(process.env[key], undefined, `Unset inherited ${key} for isolated tests`);
  const db = optOutWebhookPostgres();
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const sid = (n: number) => `SM${n.toString(16).padStart(32, "0")}`;
  let fakeAlerts = 0, memberSmsCalls = 0;
  const originalBackgroundFlag = process.env.RUN_BACKGROUND_JOBS;
  let server: Server | undefined;
  try {
    process.env.TWILIO_AUTH_TOKEN = "signed-webhook-fixture-token";
    process.env.ALERT_OPERATOR_TO = "+15550000999";
    process.env.TWILIO_PHONE_NUMBER = "+15550000998";
    supabase.from = db.from as typeof supabase.from;
    supabase.rpc = db.rpc as unknown as typeof supabase.rpc;
    process.env.RUN_BACKGROUND_JOBS = "true"; // Child process only, with fake transport and no scheduler.
    setBackgroundJobsEnabledForTests(true); // No scheduler is started.
    setOperatorAlertTransportForTests(async () => { fakeAlerts++; });
    // Honor the real SQL alert-election guard in this disposable database.
    db.sql(`INSERT INTO operator_job_locks(name,owner,expires_at)
      VALUES('background-worker','${workerIdentity.instance_id}',now()+interval '10 minutes')
      ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at;`);
    setTwilioClientFactoryForTests(() => ({ messages: { create: async () => {
      memberSmsCalls++;
      throw new Error("No member SMS transport is allowed in this test");
    } } } as unknown as ReturnType<typeof twilio>));
    for (let n = 1; n <= 3; n++) {
      db.sql(`INSERT INTO players(id,club_id,name,phone) VALUES('${uuid(n + 10)}','${uuid(1)}','Opt-out fixture ${n}','+1555000010${n}');
        INSERT INTO messages(id,player_id,body,direction,status,twilio_message_sid,sent_at,retention_delivery_kind)
        VALUES('${uuid(n + 20)}','${uuid(n + 10)}','Fixture prior invitation','outbound','sent','${sid(n + 20)}',now()-interval '1 hour','real');
        INSERT INTO retention_sequences(id,club_id,player_id,playbook_key,sequence_status,step1_sent_at,step1_message_id,step1_delivery_kind)
        VALUES('${uuid(n + 30)}','${uuid(1)}','${uuid(n + 10)}','ltp_followup','active',now()-interval '1 hour','${uuid(n + 20)}','real');
        INSERT INTO retention_candidates(id,club_id,player_id,sequence_id,playbook_key,step,message_id,sequence_status)
        VALUES('${uuid(n + 40)}','${uuid(1)}','${uuid(n + 10)}','${uuid(n + 30)}','ltp_followup',1,'${uuid(n + 20)}','active');`);
    }
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
    app.use(validateTwilioWebhook);
    app.use("/api", messagesRouter);
    await new Promise<void>(resolve => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server!.address();
    assert.ok(address && typeof address === "object");
    process.env.PUBLIC_API_URL = `http://127.0.0.1:${address.port}`;
    const cases: Array<{ label: string; path: string; expected: number; params: Record<string, string> }> = [
      { label: "STOP", path: "inbound?clubSlug=pb-club", expected: 200,
        params: { From: "+15550000101", To: "+15550000998", MessageSid: sid(1), Body: "STOP" } },
      { label: "unsubscribe + OptOutType=STOP", path: "inbound?clubSlug=pb-club", expected: 200,
        params: { From: "+15550000102", To: "+15550000998", MessageSid: sid(2), Body: "unsubscribe", OptOutType: "STOP" } },
      { label: "21610 status callback", path: "status", expected: 204,
        params: { MessageSid: sid(23), MessageStatus: "undelivered", ErrorCode: "21610",
          ErrorMessage: "Fixture recipient opted out" } },
    ];
    for (let index = 0; index < cases.length; index++) {
      const scenario = cases[index];
      const url: string = `${process.env.PUBLIC_API_URL}/api/messages/webhook/${scenario.path}`;
      const params = scenario.params;
      const request = (signature: string): Promise<Response> => fetch(url, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
        body: new URLSearchParams(params) });
      assert.equal((await request("invalid-signature")).status, 403);
      assert.equal(db.sql("SELECT count(*) FROM sms_optout_events"), String(index));
      const signature = twilio.getExpectedTwilioSignature("signed-webhook-fixture-token", url, params);
      const first = await request(signature);
      if (first.status !== scenario.expected) console.error(db.sql("SELECT processing_error FROM sms_inbound_receipts WHERE processing_error IS NOT NULL"));
      assert.equal(first.status, scenario.expected, await first.text());
      assert.equal(db.sql("SELECT count(*) FROM sms_optout_events"), String(index + 1));
      assert.equal(db.sql("SELECT count(*) FROM operator_alert_events WHERE phase='alert' AND status='sent'"), String(index + 1));
      assert.equal(fakeAlerts, index + 1);
      const eventBeforeReplay = db.sql(`SELECT to_jsonb(e) FROM sms_optout_events e WHERE player_id='${uuid(index + 11)}'`);
      for (let repeat = 0; repeat < 2; repeat++) {
        const replay = await request(signature);
        assert.equal(replay.status, scenario.expected, await replay.text());
      }
      assert.equal(db.sql("SELECT count(*) FROM sms_optout_events"), String(index + 1));
      assert.equal(db.sql("SELECT count(*) FROM operator_alert_events"), String(index + 1));
      assert.equal(db.sql(`SELECT to_jsonb(e) FROM sms_optout_events e WHERE player_id='${uuid(index + 11)}'`), eventBeforeReplay);
      assert.equal(fakeAlerts, index + 1);
      assert.equal(db.sql(`SELECT opted_out AND NOT sms_opt_in FROM players WHERE id='${uuid(index + 11)}'`), "t");
      console.log(`${scenario.label}: 1 event + 1 fake alert; two replays add 0 events/alerts`);
    }
    assert.equal(db.sql("SELECT count(*) FROM retention_sequences WHERE sequence_status='exited_opt_out'"), "3");
    for (const [n, body, kind] of [[70, "START", "start"], [71, "Thanks for the invitation", "reply"]] as const) {
      const url = `${process.env.PUBLIC_API_URL}/api/messages/webhook/inbound?clubSlug=pb-club`;
      const params = { From: "+15550000101", To: "+15550000998", MessageSid: sid(n), Body: body };
      const signature = twilio.getExpectedTwilioSignature("signed-webhook-fixture-token", url, params);
      const response = await fetch(url, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
        body: new URLSearchParams(params) });
      assert.equal(response.status, 200, await response.text());
      assert.equal(db.sql(`SELECT kind FROM sms_inbound_receipts WHERE twilio_message_sid='${sid(n)}'`), kind);
      assert.equal(db.sql("SELECT count(*) FROM sms_optout_events"), "3");
      assert.equal(fakeAlerts, 3);
    }
    assert.equal(db.sql(`SELECT sms_opt_in AND NOT opted_out FROM players WHERE id='${uuid(11)}'`), "t");
    assert.equal(db.sql("SELECT count(*) FROM retention_sequences WHERE sequence_status='exited_opt_out'"), "3",
      "START and subsequent reply do not reopen closed sequences");
    assert.equal(memberSmsCalls, 0);
  } finally {
    try {
      if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    } finally {
      setBackgroundJobsEnabledForTests(false);
      if (originalBackgroundFlag === undefined) delete process.env.RUN_BACKGROUND_JOBS;
      else process.env.RUN_BACKGROUND_JOBS = originalBackgroundFlag;
      setOperatorAlertTransportForTests(null);
      setTwilioClientFactoryForTests(null);
      supabase.from = originalFrom;
      supabase.rpc = originalRpc;
      for (const key of keys) delete process.env[key];
      db.close(); // Stops and removes the disposable cluster and every fixture row.
      assert.equal(existsSync(db.root), false);
      console.log("Cleanup: local HTTP server closed; fake hooks cleared; disposable database and all fixture rows removed");
    }
  }
});

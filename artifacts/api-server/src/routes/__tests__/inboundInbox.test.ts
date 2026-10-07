import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import express from "express";
import { supabase } from "../../lib/supabaseClient";
import messagesRouter from "../messages";
import { alertUnmatchedInbound, setOperatorAlertTransportForTests } from "../../lib/operatorMonitoring";
import { setBackgroundJobsEnabledForTests } from "../../lib/backgroundPolicy";

const saved = { from: supabase.from, rpc: supabase.rpc, env: { ...process.env } };
let result: any;
let argumentsSeen: any;
let base: string;
let server: ReturnType<typeof express.application.listen>;
const receipt = {
  id: "00000000-0000-4000-8000-000000000001", club_id: "00000000-0000-4000-8000-000000000002",
  player_id: null, message_id: null, match_reason: "unknown", kind: "reply",
  processed_at: "2026-01-01T00:00:00Z", processing_error: null, duplicate: false,
};
const payload = { From: "+15550000111", To: "+15557654321",
  MessageSid: "SM00000000000000000000000000000001", Body: "Hi" };
before(async () => {
  process.env.RETENTION_ONLY_MODE = "true";
  (supabase as any).from = () => { throw new Error("Unexpected database operation"); };
  (supabase as any).rpc = async (name: string, args: any) => {
    assert.equal(name,"capture_sms_inbound"); argumentsSeen=args; return result;
  };
  const app = express(); app.use(express.urlencoded({extended:false}));
  app.use((req,_res,next) => { (req as any).log={info(){},warn(){},error(){}}; next(); });
  app.use("/api",messagesRouter);
  await new Promise<void>(resolve => { server=app.listen(0,"127.0.0.1",() => {
    const addr=server.address(); base=`http://127.0.0.1:${typeof addr === "object" ? addr?.port : 0}`; resolve();
  }); });
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  (supabase as any).from=saved.from; (supabase as any).rpc=saved.rpc;
  setBackgroundJobsEnabledForTests(false); setOperatorAlertTransportForTests(null);
  for (const k of ["RETENTION_ONLY_MODE","ALERT_OPERATOR_TO","TWILIO_PHONE_NUMBER","RUN_BACKGROUND_JOBS"]) {
    if (saved.env[k]===undefined) delete process.env[k]; else process.env[k]=saved.env[k];
  }
});
const post = (body=payload, suffix="") => fetch(`${base}/api/messages/webhook/inbound${suffix}`, {
  method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(body),
});
test("unknown reply/STOP and ambiguous reply acknowledge only durable club-scoped receipt", async () => {
  for (const variant of [receipt,{...receipt,kind:"stop"},{...receipt,match_reason:"ambiguous"}]) {
    result={data:variant,error:null};
    const response=await post({...payload,Body:variant.kind==="stop" ? "STOP" : "Hi"});
    assert.equal(response.status,200); assert.equal(await response.text(),"<Response></Response>");
    assert.equal(argumentsSeen.p_body,variant.kind==="stop" ? "STOP" : "Hi");
    assert.equal(argumentsSeen.p_sid,payload.MessageSid);
  }
});
test("persistence or pause errors never return false successful TwiML; successful replay is harmless", async () => {
  result={data:null,error:{message:"Fixture storage unavailable"}};
  assert.equal((await post()).status,503);
  result={data:{...receipt,player_id:"known",processing_error:"Fixture pause failure",processed_at:null},error:null};
  assert.equal((await post()).status,503);
  result={data:{...receipt,duplicate:true,player_id:"known"},error:null};
  assert.equal((await post()).status,200,"replay must not execute another legacy response");
  assert.equal((await post({...payload,MessageSid:"bad"})).status,400);
  result={data:receipt,error:null}; await post(payload,"?clubSlug=other-club");
  assert.equal(argumentsSeen.p_club_slug,"other-club");
});
test("unmatched operator alerts are worker-only, claimed once and never use live transport", async () => {
  let attempted: string | null=null; let submits=0; let observed=false;
  process.env.ALERT_OPERATOR_TO="+15550000999"; process.env.TWILIO_PHONE_NUMBER="+15557654321";
  setOperatorAlertTransportForTests(async () => { submits++; });
  (supabase as any).rpc=async (name:string,args:any) => {
    assert.equal(name,"operator_observe_alert"); assert.equal(args.p_key,`unmatched_inbound:${receipt.id}`);
    if (observed) return {data:null,error:null}; observed=true;
    return {data:{id:"event",incident_id:"incident",phase:"alert",text:args.p_text},error:null};
  };
  (supabase as any).from=(table:string) => {
    let write:any;
    const query:any={ select(){return query;},is(){return query;},eq(){return query;},order(){return query;},limit(){return query;},
      update(v:any){write=v;return query;},then(ok:any,bad:any) {
        if (table==="sms_inbound_receipts" && write) attempted=write.operator_alert_attempted_at;
        const data=table==="sms_inbound_receipts" && !write && !attempted ? [{...receipt,kind:"stop"}] : [];
        return Promise.resolve({data,error:null}).then(ok,bad);
      }};
    return query;
  };
  setBackgroundJobsEnabledForTests(false); await alertUnmatchedInbound(); assert.equal(submits,0);
  setBackgroundJobsEnabledForTests(true);
  process.env.RUN_BACKGROUND_JOBS="true";
  await alertUnmatchedInbound(); await alertUnmatchedInbound();
  assert.equal(submits,1); assert.ok(attempted);
});

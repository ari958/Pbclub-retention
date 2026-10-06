BEGIN;
INSERT INTO public.clubs VALUES ('00000000-0000-4000-8000-000000000001');
INSERT INTO public.players(id,club_id) VALUES
 ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001');
INSERT INTO public.retention_playbooks VALUES ('ltp_followup',true,'{
 "step2_gap_days":7,
 "step1":{"opener":["Hi {first}, it''s PB Club."],"thanks":["Thanks for coming to Learn to Play on {ltp_date}."],
 "next_step":["{program} on {when}."],"offer":["25% off {promo}:"],"offer_no_program":["25% off {promo}:"]},
 "step2":{"opener":["Hi {first}, it''s PB Club."],"nudge":["Hope you''re ready to get back out there."],
 "next_step":["{program} on {when} still has spots."],"no_program_cta":["Here''s what''s coming up:"]}}');
INSERT INTO public.messages(id,player_id,body,status,sent_at,retention_delivery_kind,delivery_status,delivered_at) VALUES
 ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','Original test step 1','sent',now()-interval '2 minutes','test','delivered',now()-interval '1 minute'),
 ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000003','Original real step 1','sent',now()-interval '2 minutes','real','delivered',now()-interval '1 minute');
INSERT INTO public.contact_ledger(message_id,is_test) VALUES
 ('00000000-0000-4000-8000-000000000004',true),('00000000-0000-4000-8000-000000000005',false);
INSERT INTO public.retention_sequences(id,club_id,player_id,playbook_key,trigger_event_id,step1_message_id,step1_sent_at,step1_delivery_kind) VALUES
 ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','ltp_followup','trigger-test','00000000-0000-4000-8000-000000000004',now()-interval '2 minutes','test'),
 ('00000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','ltp_followup','trigger-real','00000000-0000-4000-8000-000000000005',now()-interval '2 minutes','real');
INSERT INTO public.retention_candidates(id,club_id,player_id,playbook_key,trigger_event_id,context,status,message_id,step,sequence_id) VALUES
 ('00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','ltp_followup','trigger-test','{"trigger":{"date":"2026-09-20"}}','sent','00000000-0000-4000-8000-000000000004',1,'00000000-0000-4000-8000-000000000006'),
 ('00000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','ltp_followup','trigger-real','{"trigger":{"date":"2026-09-20"}}','sent','00000000-0000-4000-8000-000000000005',1,'00000000-0000-4000-8000-000000000007');
CREATE TEMP TABLE unchanged_messages AS SELECT * FROM public.messages;
DO $test$
DECLARE club uuid:='00000000-0000-4000-8000-000000000001';
  step1 uuid:='00000000-0000-4000-8000-000000000008'; result jsonb; refused boolean:=false;
BEGIN
  BEGIN PERFORM public.retention_ltp_test_rpc(club,'backdate',jsonb_build_object('candidate_id',step1,'actor','Fixture operator'),false);
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  PERFORM public.fixture_assert(refused,'backdate refused without override');
  refused:=false;
  BEGIN PERFORM public.retention_ltp_test_rpc(club,'backdate',
    '{"candidate_id":"00000000-0000-4000-8000-000000000009","actor":"Fixture operator"}',true);
  EXCEPTION WHEN OTHERS THEN refused:=true; END;
  PERFORM public.fixture_assert(refused,'real step-1 send cannot be backdated');
  result:=public.retention_ltp_test_rpc(club,'backdate',jsonb_build_object('candidate_id',step1,'actor','Fixture operator'),true);
  PERFORM public.fixture_assert(result->>'action'='backdate','backdate writes an audit entry');
  PERFORM public.fixture_assert((result->>'original_sent_at')::timestamptz-(result->>'effective_sent_at')::timestamptz=interval '7 days','effective timestamp backdated exactly seven days');
  result:=public.retention_ltp_test_rpc(club,'due',jsonb_build_object('candidate_ids',jsonb_build_array(step1)),true);
  PERFORM public.fixture_assert(jsonb_array_length(result)=1 AND result->0->>'step1_delivery_kind'='test','backdated test step 1 is due only in test job');
  PERFORM public.fixture_assert(public.retention_sequence_due_step2(club)='[]'::jsonb,'normal due job unaffected by test backdate');
   result:=public.retention_sequence_transition(club,'00000000-0000-4000-8000-000000000002',
     'ltp_followup','paused_reply','player_reply',NULL);
   PERFORM public.fixture_assert(result->>'sequence_status'='paused_reply','reply transition pauses the sequence');
  result:=public.retention_ltp_test_rpc(club,'due',jsonb_build_object('candidate_ids',jsonb_build_array(step1)),true);
  PERFORM public.fixture_assert(result='[]'::jsonb,'reply pause prevents another draft');
   UPDATE public.retention_sequences SET sequence_status='active',exit_reason=NULL WHERE id='00000000-0000-4000-8000-000000000006';
   UPDATE public.retention_candidates SET sequence_status='active',exit_reason=NULL WHERE sequence_id='00000000-0000-4000-8000-000000000006';
END $test$;

-- Exercise the actual installed save-batch body, not a source-pattern mock.
DO $test$
DECLARE club uuid:='00000000-0000-4000-8000-000000000001'; context jsonb; item jsonb; refused boolean:=false;
BEGIN
  context:=jsonb_build_object('player_first_name','Test','trigger',jsonb_build_object('date','2026-09-20','event_id','trigger-test'),
    'variant','no_program','next_program',null,'promo',null,'reason',null,'errors','[]'::jsonb,
    'booking_url','https://pbclub.podplay.app','send_date_et',to_char(now() AT TIME ZONE 'America/New_York','YYYY-MM-DD'),
    'ltp_text',jsonb_build_object('step',2,'seed_nonce',0,'opener','Hi Test, it''s PB Club.','ltp_date','Sept 20','when',null,
      'slot_indices','{"opener":0,"nudge":0,"no_program_cta":0}'::jsonb,
      'slot_templates','{"opener":"Hi {first}, it''s PB Club.","nudge":"Hope you''re ready to get back out there.","no_program_cta":"Here''s what''s coming up:"}'::jsonb));
  item:=jsonb_build_object('id','00000000-0000-4000-8000-000000000010','club_id',club,
    'player_id','00000000-0000-4000-8000-000000000002','playbook_key','ltp_followup','trigger_event_id','trigger-test',
    'step',2,'operation','create','context',context,'status','drafted',
    'body','Hi Test, it''s PB Club. Hope you''re ready to get back out there. Here''s what''s coming up: https://pbclub.podplay.app',
    'capacity_event_id',null,'open_spots',null,'event_start_time',null);
  BEGIN PERFORM public.retention_sequence_save_batch(club,jsonb_build_array(item));
  EXCEPTION WHEN OTHERS THEN refused:=true; END;
  PERFORM public.fixture_assert(refused,'real save RPC refuses test step 1');
  PERFORM public.retention_ltp_test_rpc(club,'save',jsonb_build_object('items',jsonb_build_array(item)),true);
  PERFORM public.fixture_assert(EXISTS(SELECT 1 FROM public.retention_candidates c JOIN public.messages m ON m.id=c.message_id
    WHERE c.step=2 AND c.status='drafted' AND m.approved_at IS NULL AND m.scheduled_send_at IS NULL AND m.sent_at IS NULL),'test save produces an unapproved unscheduled step-2 draft');
END $test$;

DO $test$
DECLARE club uuid:='00000000-0000-4000-8000-000000000001'; msg uuid; refused boolean:=false; result jsonb;
BEGIN
  SELECT message_id INTO msg FROM public.retention_candidates WHERE id='00000000-0000-4000-8000-000000000010';
  BEGIN PERFORM public.retention_ltp_test_rpc(club,'claim',jsonb_build_object('message_id',msg),true);
  EXCEPTION WHEN OTHERS THEN refused:=true; END;
  PERFORM public.fixture_assert(refused,'test claim does not bypass operator approval');
  PERFORM public.retention_ltp_test_rpc(club,'simulate_booking',
    '{"candidate_id":"00000000-0000-4000-8000-000000000008","actor":"Fixture operator"}',true);
  result:=public.retention_ltp_test_rpc(club,'exit_booked',jsonb_build_object('message_id',msg,'actor','Fixture operator'),true);
  PERFORM public.fixture_assert(result->>'sequence_status'='exited_booked','booking at dispatch exits the test sequence');
  PERFORM public.fixture_assert(EXISTS(SELECT 1 FROM public.messages WHERE id=msg AND status='skipped'
    AND approved_at IS NULL AND scheduled_send_at IS NULL AND sent_at IS NULL),'booking withdraws draft without approving scheduling or sending');
  PERFORM public.fixture_assert((SELECT count(*) FROM public.retention_ltp_test_audit)=3,'who/when/candidate/times audited for backdate booking and blocked dispatch');
END $test$;

-- Delivered completion uses a separate fake cohort; accepted/queued is not delivery.
UPDATE public.retention_sequences SET sequence_status='active' WHERE id='00000000-0000-4000-8000-000000000006';
UPDATE public.retention_candidates SET sequence_status='active' WHERE sequence_id='00000000-0000-4000-8000-000000000006';
UPDATE public.retention_ltp_test_controls SET simulated_booking=false;
UPDATE public.retention_candidates SET status='sent' WHERE step=2;
UPDATE public.messages SET status='sent',sent_at=now(),retention_delivery_kind='test',
  dispatch_claimed_at=now()-interval '1 minute',delivery_status='queued'
  WHERE id=(SELECT message_id FROM public.retention_candidates WHERE step=2);
INSERT INTO public.contact_ledger(message_id,is_test,sent_at,player_id,intended_player_id)
SELECT message_id,true,now(),player_id,player_id FROM public.retention_candidates WHERE step=2;
DO $test$
DECLARE club uuid:='00000000-0000-4000-8000-000000000001'; msg uuid; result jsonb;
BEGIN
  SELECT message_id INTO msg FROM public.retention_candidates WHERE step=2;
  result:=public.retention_ltp_test_rpc(club,'record_send',jsonb_build_object('message_id',msg,'delivery_kind','test'),true);
  PERFORM public.fixture_assert(result->>'sequence_status'='active','queued test send is not completion');
  UPDATE public.messages SET delivery_status='delivered',delivered_at=now() WHERE id=msg;
  result:=public.retention_ltp_test_rpc(club,'record_send',jsonb_build_object('message_id',msg,'delivery_kind','test'),true);
  PERFORM public.fixture_assert(result->>'sequence_status'='completed','delivered test step 2 completes the sequence');
  PERFORM public.fixture_assert(public.retention_ltp_test_rpc(club,'due',
    '{"candidate_ids":["00000000-0000-4000-8000-000000000008"]}',true)='[]'::jsonb,'completed step 2 never produces a further draft');
  PERFORM public.fixture_assert(NOT EXISTS(SELECT 1 FROM public.retention_candidates WHERE step>2),'no step 3 exists');
  PERFORM public.fixture_assert(NOT EXISTS((SELECT * FROM public.messages WHERE id IN(SELECT id FROM unchanged_messages))
    EXCEPT (SELECT * FROM unchanged_messages)),'original sent messages and approval/send evidence unchanged');
END $test$;

DO $test$
DECLARE club uuid:='00000000-0000-4000-8000-000000000001';
  candidate uuid:='00000000-0000-4000-8000-000000000010'; msg uuid;
  refused boolean:=false; result jsonb;
BEGIN
  SELECT message_id INTO msg FROM public.retention_candidates WHERE id=candidate;
  BEGIN PERFORM public.retention_ltp_test_reset(club,candidate,'Fixture operator',false);
  EXCEPTION WHEN insufficient_privilege THEN refused:=true; END;
  PERFORM public.fixture_assert(refused,'reset refused without override');
  PERFORM public.fixture_assert(has_function_privilege('service_role',
    'public.retention_ltp_test_reset(uuid,uuid,text,boolean)','EXECUTE'),'service role may invoke reset');
  PERFORM public.fixture_assert(NOT has_function_privilege('authenticated',
    'public.retention_ltp_test_reset(uuid,uuid,text,boolean)','EXECUTE'),'authenticated role cannot invoke reset');
  DELETE FROM public.contact_ledger WHERE message_id=msg;
  UPDATE public.messages SET simulated=true,retention_delivery_kind='simulated' WHERE id=msg;
  refused:=false;
  BEGIN PERFORM public.retention_ltp_test_reset(club,candidate,'Fixture operator',true);
  EXCEPTION WHEN OTHERS THEN refused:=true; END;
  PERFORM public.fixture_assert(refused,'delivered step cannot be reset');
  UPDATE public.messages SET delivered_at=NULL,delivery_status=NULL,simulated=true,
    retention_delivery_kind='simulated',twilio_message_sid='SMactual-provider-sid' WHERE id=msg;
  refused:=false;
  BEGIN PERFORM public.retention_ltp_test_reset(club,candidate,'Fixture operator',true);
  EXCEPTION WHEN OTHERS THEN refused:=true; END;
  PERFORM public.fixture_assert(refused,'any actual Twilio SID prevents reset');
  UPDATE public.messages SET twilio_message_sid='SIMULATED' WHERE id=msg;
  result:=public.retention_ltp_test_reset(club,candidate,'Fixture operator',true);
  PERFORM public.fixture_assert(result->>'status'='needs_context','reset requires fresh context before approval');
  PERFORM public.fixture_assert(EXISTS(SELECT 1 FROM public.messages WHERE id=msg AND status='pending'
    AND approved_at IS NULL AND scheduled_send_at IS NULL AND sent_at IS NULL
    AND dispatch_claimed_at IS NULL AND twilio_message_sid IS NULL),'reset clears simulation and approval without scheduling or sending');
  PERFORM public.fixture_assert(EXISTS(SELECT 1 FROM public.retention_sequences
    WHERE id='00000000-0000-4000-8000-000000000006' AND sequence_status='active' AND step2_sent_at IS NULL),'reset restores active sequence and clears simulated step-2 clock');
  PERFORM public.fixture_assert(EXISTS(SELECT 1 FROM public.retention_ltp_test_audit
    WHERE action='reset_simulated' AND candidate_id=candidate AND actor='Fixture operator'
      AND details->'message'->>'twilio_message_sid'='SIMULATED'),'reset audit preserves simulation and approval evidence');
END $test$;
ROLLBACK;

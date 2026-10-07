-- Run only in an isolated fixture, with the real 013 writers and migration 018.
INSERT INTO public.clubs VALUES ('00000000-0000-4000-8000-000000000001');
INSERT INTO public.players(id,club_id) VALUES
 ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001');
INSERT INTO public.retention_playbooks VALUES ('ltp_followup',true,'{
 "step2_gap_days":7,
 "step1":{"opener":["Hi {first}, it''s PB Club."],"thanks":["Thanks for coming to Learn to Play on {ltp_date}."],
 "next_step":["{program} on {when}."],"offer":["Use code {promo} for 25% off:"],"offer_no_program":["Use code {promo} for 25% off:"]},
 "step2":{"opener":["Hi {first}, it''s PB Club."],"nudge":["Come back soon."],
 "next_step":["{program} on {when}."],"no_program_cta":["Here''s what''s coming up:"]}}');
INSERT INTO public.messages(id,player_id,body,status,direction,error_message,sent_at) VALUES
 ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002',
  'Archived original text','archived','outbound','pre_launch_reset',NULL);
INSERT INTO public.retention_sequences(id,club_id,player_id,playbook_key,trigger_event_id) VALUES
 ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002','ltp_followup','trigger');
INSERT INTO public.retention_candidates(id,club_id,player_id,playbook_key,trigger_event_id,context,status,message_id,step,sequence_id) VALUES
 ('00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002','ltp_followup','trigger',
  '{"trigger":{"date":"2026-10-06"},"reason":"pre_launch_reset"}','skipped',
  '00000000-0000-4000-8000-000000000004',1,'00000000-0000-4000-8000-000000000006');

CREATE TEMP TABLE replacement AS SELECT jsonb_build_array(jsonb_build_object(
 'id','00000000-0000-4000-8000-000000000009',
 'player_id','00000000-0000-4000-8000-000000000002','playbook_key','ltp_followup',
 'trigger_event_id','trigger','step',1,'operation','create','status','drafted',
 'body','Hi Fixture, it''s PB Club. Thanks for coming to Learn to Play on Oct 6. Use code LTPNEXT25 for 25% off: https://pbclub.podplay.app',
 'context','{
   "trigger":{"event_id":"trigger","date":"2026-10-06"},
   "player_first_name":"Fixture","variant":"no_program","next_program":null,
   "booking_url":"https://pbclub.podplay.app",
   "promo":{"code":"LTPNEXT25","offer_text":"25% off your next program"},
   "ltp_text":{"step":1,"opener":"Hi Fixture, it''s PB Club.","ltp_date":"Oct 6","seed_nonce":0,
     "slot_indices":{"opener":0,"thanks":0,"offer_no_program":0},
     "slot_templates":{"opener":"Hi {first}, it''s PB Club.",
       "thanks":"Thanks for coming to Learn to Play on {ltp_date}.",
       "offer_no_program":"Use code {promo} for 25% off:"}}
 }'::jsonb
)) AS items;
CREATE TEMP TABLE old_messages AS SELECT to_jsonb(m) AS snapshot FROM public.messages m;
CREATE TEMP TABLE old_candidates AS SELECT to_jsonb(c)-'prelaunch_superseded_by' AS snapshot FROM public.retention_candidates c;
CREATE TEMP TABLE old_sequences AS SELECT to_jsonb(s) AS snapshot FROM public.retention_sequences s;

DO $test$
DECLARE club uuid:='00000000-0000-4000-8000-000000000001';
  field text; refused boolean; items jsonb;
BEGIN
  SELECT replacement.items INTO items FROM replacement;
  PERFORM public.fixture_assert(public.retention_prelaunch_reset_ready(),'reset migration is ready');
  -- Each refusal runs in its own rolled-back subtransaction.
  FOREACH field IN ARRAY ARRAY['approved_at','scheduled_send_at','sent_at',
    'dispatch_claimed_at','delivered_at'] LOOP
    refused:=false;
    BEGIN
      EXECUTE format('UPDATE public.messages SET %I=now()',field);
      PERFORM public.retention_sequence_save_batch(club,items);
      RAISE EXCEPTION 'unexpectedly accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM='unexpectedly accepted' THEN RAISE; END IF;
      refused:=true;
    END;
    PERFORM public.fixture_assert(refused,'refused timestamp evidence: '||field);
  END LOOP;
  FOREACH field IN ARRAY ARRAY['approved_by','approved_body','twilio_message_sid',
    'delivery_status','retention_delivery_kind'] LOOP
    BEGIN
      EXECUTE format('UPDATE public.messages SET %I=''evidence''',field);
      PERFORM public.retention_sequence_save_batch(club,items);
      RAISE EXCEPTION 'unexpectedly accepted';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM='unexpectedly accepted' THEN RAISE; END IF; END;
  END LOOP;
  BEGIN
    UPDATE public.messages SET simulated=true;
    PERFORM public.retention_sequence_save_batch(club,items);
    RAISE EXCEPTION 'unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='unexpectedly accepted' THEN RAISE; END IF; END;
  BEGIN
    UPDATE public.messages SET dispatch_token=gen_random_uuid();
    PERFORM public.retention_sequence_save_batch(club,items);
    RAISE EXCEPTION 'unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='unexpectedly accepted' THEN RAISE; END IF; END;
  BEGIN
    UPDATE public.retention_candidates SET context='{"reason":"operator_skip"}';
    PERFORM public.retention_sequence_save_batch(club,items);
    RAISE EXCEPTION 'unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='unexpectedly accepted' THEN RAISE; END IF; END;
  BEGIN
    UPDATE public.players SET opted_out=true;
    PERFORM public.retention_sequence_save_batch(club,items);
    RAISE EXCEPTION 'unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='unexpectedly accepted' THEN RAISE; END IF; END;
  BEGIN
    INSERT INTO public.contact_ledger(player_id) VALUES('00000000-0000-4000-8000-000000000002');
    PERFORM public.retention_sequence_save_batch(club,items);
    RAISE EXCEPTION 'unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='unexpectedly accepted' THEN RAISE; END IF; END;
  BEGIN
    UPDATE public.retention_sequences SET step1_sent_at=now();
    PERFORM public.retention_sequence_save_batch(club,items);
    RAISE EXCEPTION 'unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='unexpectedly accepted' THEN RAISE; END IF; END;
  -- Replacement and its metadata link roll back if ANY later batch item fails.
  BEGIN
    PERFORM public.retention_sequence_save_batch(club,items || jsonb_build_array(
      (items->0)||jsonb_build_object('id','00000000-0000-4000-8000-000000000010',
        'step',2,'context',(items->0->'context')||'{"ltp_text":{"step":2}}'::jsonb)));
    RAISE EXCEPTION 'unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='unexpectedly accepted' THEN RAISE; END IF; END;
  PERFORM public.fixture_assert((SELECT prelaunch_superseded_by IS NULL FROM public.retention_candidates),
    'failed whole-cohort write leaves archive link untouched');
  PERFORM public.retention_sequence_save_batch(club,items);
  PERFORM public.fixture_assert((SELECT count(*)=2 FROM public.retention_candidates),'new candidate created; old retained');
  PERFORM public.fixture_assert((SELECT prelaunch_superseded_by='00000000-0000-4000-8000-000000000009'
    FROM public.retention_candidates WHERE id='00000000-0000-4000-8000-000000000008'),'history links to replacement');
  PERFORM public.fixture_assert((SELECT count(*)=1 FROM public.messages
    WHERE status='pending' AND approved_at IS NULL AND scheduled_send_at IS NULL AND sent_at IS NULL),
    'new draft is unapproved, unscheduled and unsent despite legacy sent_at default');
  PERFORM public.fixture_assert((SELECT snapshot=(SELECT to_jsonb(m) FROM public.messages m
    WHERE id='00000000-0000-4000-8000-000000000004') FROM old_messages),'archived message unchanged');
  PERFORM public.fixture_assert((SELECT snapshot=(SELECT to_jsonb(c)-'prelaunch_superseded_by'
    FROM public.retention_candidates c WHERE id='00000000-0000-4000-8000-000000000008')
    FROM old_candidates),'all original candidate fields unchanged');
  PERFORM public.fixture_assert((SELECT snapshot=(SELECT to_jsonb(s) FROM public.retention_sequences s)
    FROM old_sequences),'sequence delivery evidence unchanged');
  BEGIN
    PERFORM public.retention_sequence_save_batch(club,jsonb_build_array(
      (items->0)||'{"id":"00000000-0000-4000-8000-000000000011"}'::jsonb));
    RAISE EXCEPTION 'unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='unexpectedly accepted' THEN RAISE; END IF; END;
  PERFORM public.fixture_assert((SELECT count(*)=2 FROM public.retention_candidates),'second generation cannot duplicate replacement');
  PERFORM public.retention_sequence_transition(club,'00000000-0000-4000-8000-000000000002',
    'ltp_followup','paused_reply','player_reply',NULL);
  PERFORM public.fixture_assert((SELECT snapshot=(SELECT to_jsonb(c)-'prelaunch_superseded_by'
    FROM public.retention_candidates c WHERE id='00000000-0000-4000-8000-000000000008')
    FROM old_candidates),'later sequence transition preserves archived candidate fields');
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;

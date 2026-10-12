-- Run only in an isolated fixture after the real 013 writers, 018 and 031.
-- Uses its own UUID range (…0100 and up) so it can follow prelaunchReset.assert.sql.
INSERT INTO public.players(id,club_id) VALUES
 ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001');

INSERT INTO public.retention_playbooks(key,enabled,ltp_sequence_config,flow_kind,trigger_program_label,
  verified_promo_code,verified_offer_phrase,booking_url)
VALUES ('winback_followup',true,'{
 "step2_gap_days":7,
 "step1":{"opener":["Hi {first}, it''s PB Club."],"thanks":["Thanks for coming to Open Play Intro on {ltp_date}."],
 "next_step":["{program} on {when}."],"offer":["Use code {promo} for 15% off:"],"offer_no_program":["Use code {promo} for 15% off your next visit:"]},
 "step2":{"opener":["Hi {first}, it''s PB Club."],"nudge":["Come back soon."],
 "next_step":["{program} on {when}."],"no_program_cta":["Here''s what''s coming up:"]}}',
 'sequence','Open Play Intro','WELCOME15','15% off','https://pbclub.podplay.app/book');
INSERT INTO public.retention_playbooks(key,enabled,ltp_sequence_config) VALUES ('legacy_single',true,NULL);

CREATE TEMP TABLE winback AS SELECT jsonb_build_array(jsonb_build_object(
 'id','00000000-0000-4000-8000-000000000109',
 'player_id','00000000-0000-4000-8000-000000000102','playbook_key','winback_followup',
 'trigger_event_id','intro-1','step',1,'operation','create','status','drafted',
 'body','Hi Pat, it''s PB Club. Thanks for coming to Open Play Intro on Oct 6. Use code WELCOME15 for 15% off your next visit: https://pbclub.podplay.app/book',
 'context','{
   "trigger":{"event_id":"intro-1","date":"2026-10-06"},
   "player_first_name":"Pat","variant":"no_program","next_program":null,
   "booking_url":"https://pbclub.podplay.app/book",
   "promo":{"code":"WELCOME15","offer_text":"15% off your next visit"},
   "ltp_text":{"step":1,"opener":"Hi Pat, it''s PB Club.","ltp_date":"Oct 6","seed_nonce":0,
     "slot_indices":{"opener":0,"thanks":0,"offer_no_program":0},
     "slot_templates":{"opener":"Hi {first}, it''s PB Club.",
       "thanks":"Thanks for coming to Open Play Intro on {ltp_date}.",
       "offer_no_program":"Use code {promo} for 15% off your next visit:"}}
 }'::jsonb
)) AS items;

DO $test$
DECLARE club uuid:='00000000-0000-4000-8000-000000000001';
  player uuid:='00000000-0000-4000-8000-000000000102';
  items jsonb; wrong jsonb; refused boolean; v_name text; saved jsonb; created uuid;
BEGIN
  SELECT winback.items INTO items FROM winback;
  PERFORM public.fixture_assert(public.retention_sequence_ready(),'sequence schema is ready after 031');
  PERFORM public.fixture_assert(
    (SELECT flow_kind='sequence' AND trigger_program_label='Learn to Play' AND verified_promo_code='LTPNEXT25'
       AND verified_offer_phrase='25% off' AND booking_url='https://pbclub.podplay.app'
     FROM public.retention_playbooks WHERE key='ltp_followup'),
    'ltp_followup carries the rules the functions used to hard-code');
  PERFORM public.fixture_assert(NOT EXISTS(SELECT 1 FROM pg_constraint
    WHERE conrelid='public.retention_candidates'::regclass AND conname='retention_candidates_ltp_sequence_identity_check'),
    'literal identity CHECK is gone');
  PERFORM public.fixture_assert(NOT EXISTS(SELECT 1 FROM pg_constraint
    WHERE conrelid='public.retention_playbooks'::regclass AND conname='retention_playbooks_ltp_sequence_gap_check'),
    'literal gap CHECK is gone');
  FOR v_name IN SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'retention_create_candidate','retention_create_draft','retention_regenerate_draft',
      'retention_manual_edit_candidate','retention_retry_context','retention_sequence_transition',
      'retention_sequence_player_optout_changed','retention_sequence_session_changed',
      'retention_sequence_due_step2','retention_sequence_save_batch','retention_sequence_save_batch_test',
      'retention_sequence_claim','retention_sequence_record_send','retention_update_candidate',
      'retention_sequence_ready','capture_sms_inbound')
  LOOP
    PERFORM public.fixture_assert(strpos(pg_get_functiondef(('public.'||v_name)::regproc),'''ltp_followup''')=0
      AND strpos(pg_get_functiondef(('public.'||v_name)::regproc),'LTPNEXT25')=0
      AND strpos(pg_get_functiondef(('public.'||v_name)::regproc),'pbclub.podplay.app')=0,
      'no literal LTP rule left in '||v_name);
  END LOOP;
  PERFORM public.fixture_assert(strpos(pg_get_functiondef('public.retention_sequence_save_batch'::regproc),
    'only archived pre-launch resets can be replaced')>0,'018 amendment survives 031');

  -- Single-draft playbooks keep their legacy writer; sequence playbooks are refused there.
  created:=public.retention_create_candidate(club,player,'legacy_single','evt-1',
    '{"trigger":{"event_id":"evt-1"}}'::jsonb,'drafted','Hi Pat, see you soon.');
  PERFORM public.fixture_assert(created IS NOT NULL,'legacy single-draft candidate still writes');
  refused:=false;
  BEGIN
    PERFORM public.retention_create_candidate(club,player,'winback_followup','evt-2',
      '{"trigger":{"event_id":"evt-2"}}'::jsonb,'drafted','Hi Pat.');
  EXCEPTION WHEN OTHERS THEN refused:=SQLERRM LIKE '%sequence playbook%'; END;
  PERFORM public.fixture_assert(refused,'legacy writer refuses a sequence playbook by kind');
  refused:=false;
  BEGIN
    UPDATE public.retention_candidates SET sequence_id=gen_random_uuid() WHERE id=created;
  EXCEPTION WHEN OTHERS THEN refused:=SQLERRM LIKE '%cannot carry sequence state%'; END;
  PERFORM public.fixture_assert(refused,'identity trigger blocks sequence state on a single-draft playbook');

  -- A second sequence flow writes through the same batch RPC with its own rules.
  saved:=public.retention_sequence_save_batch(club,items);
  PERFORM public.fixture_assert(jsonb_array_length(saved)=1 AND saved->0->>'status'='drafted'
    AND saved->0->>'playbook_key'='winback_followup','second flow step 1 drafted');
  PERFORM public.fixture_assert(EXISTS(SELECT 1 FROM public.retention_sequences
    WHERE club_id=club AND player_id=player AND playbook_key='winback_followup' AND sequence_status='active'),
    'second flow opened its own sequence root');
  PERFORM public.fixture_assert(EXISTS(SELECT 1 FROM public.messages m JOIN public.retention_candidates c ON c.message_id=m.id
    WHERE c.id='00000000-0000-4000-8000-000000000109' AND m.status='pending' AND m.approved_at IS NULL AND m.sent_at IS NULL),
    'second flow draft is unapproved and unsent');

  -- The LTP coupon is not a verified offer for the second flow.
  wrong:=jsonb_build_array((items->0)||jsonb_build_object('id','00000000-0000-4000-8000-000000000110',
    'player_id','00000000-0000-4000-8000-000000000002',
    'body',replace(replace(items->0->>'body','WELCOME15','LTPNEXT25'),'15% off','25% off'),
    'context',(items->0->'context')||'{"promo":{"code":"LTPNEXT25","offer_text":"25% off your next program"}}'::jsonb));
  refused:=false;
  BEGIN
    PERFORM public.retention_sequence_save_batch(club,wrong);
  EXCEPTION WHEN OTHERS THEN refused:=SQLERRM LIKE '%Open Play Intro and WELCOME15%'; END;
  PERFORM public.fixture_assert(refused,'second flow rejects the LTP coupon by its own rule');

  -- One playbook per batch.
  refused:=false;
  BEGIN
    PERFORM public.retention_sequence_save_batch(club,items||jsonb_build_array((items->0)||jsonb_build_object(
      'id','00000000-0000-4000-8000-000000000111','playbook_key','ltp_followup')));
  EXCEPTION WHEN OTHERS THEN refused:=SQLERRM LIKE '%exactly one playbook%'; END;
  PERFORM public.fixture_assert(refused,'mixed-playbook batch refused');

  -- Lifecycle transitions and approval validation follow the playbook row.
  PERFORM public.retention_sequence_transition(club,player,'winback_followup','paused_reply','player_reply',NULL);
  PERFORM public.fixture_assert((SELECT sequence_status='paused_reply' FROM public.retention_sequences
    WHERE club_id=club AND player_id=player AND playbook_key='winback_followup'),'second flow transition applied');
  refused:=false;
  BEGIN
    PERFORM public.retention_sequence_transition(club,player,'legacy_single','paused_reply','player_reply',NULL);
  EXCEPTION WHEN OTHERS THEN refused:=SQLERRM LIKE '%Unsupported LTP sequence transition%'; END;
  PERFORM public.fixture_assert(refused,'single-draft playbook has no sequence to transition');
  UPDATE public.players SET opted_out=true WHERE id=player;
  PERFORM public.fixture_assert((SELECT sequence_status='exited_opt_out' FROM public.retention_sequences
    WHERE club_id=club AND player_id=player AND playbook_key='winback_followup'),'opt-out trigger exits the second flow');
END $test$;
SET CONSTRAINTS ALL IMMEDIATE;

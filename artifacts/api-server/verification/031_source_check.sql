-- READ-ONLY source check for migration 031. Safe to run in production.
--
-- Paste into the production Supabase SQL Editor and click Run. It changes no
-- table, row or function: it reads each function 031 amends and reports, for
-- every text substitution 031 would make, whether the live text matches.
--   ok: will amend       -> 031 will apply this change.
--   ok: already amended  -> 031 already applied here; it will be skipped.
--   MISMATCH             -> the live text differs; "live_text" shows it with
--                           <NL> newlines, <TAB> tabs and <CR> carriage returns.
-- Only session-local temp objects are created; they vanish with the session.
--
-- Carriage returns are ignored on both sides: copying this file through a
-- browser or Windows clipboard turns its line breaks into CR+LF, while the
-- installed functions use LF. Without this, every multi-line search misses.
--
-- The substitution list below is copied from migration 031 (a test enforces it).
CREATE TEMP TABLE IF NOT EXISTS retention_flow_report(
  function_name text, pair integer, status text, expected_text text, live_text text);
TRUNCATE retention_flow_report;

CREATE OR REPLACE FUNCTION pg_temp.retention_flow_check(p_name text,p_signature text,p_pairs text[],p_required boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_proc regprocedure; v_source text; v_index integer; v_old text; v_new text;
  v_first text; v_at integer; v_status text; v_live text;
BEGIN
  v_proc:=to_regprocedure('public.'||p_name||'('||p_signature||')');
  IF v_proc IS NULL THEN
    INSERT INTO retention_flow_report VALUES(p_name,0,
      CASE WHEN p_required THEN 'MISMATCH: function is missing' ELSE 'ok: optional function absent' END,NULL,NULL);
    RETURN;
  END IF;
  v_source:=replace(pg_get_functiondef(v_proc),chr(13),'');
  FOR v_index IN 1..array_length(p_pairs,1) BY 2 LOOP
    v_old:=replace(p_pairs[v_index],chr(13),''); v_new:=replace(p_pairs[v_index+1],chr(13),''); v_live:=NULL;
    IF strpos(v_source,v_new)>0 THEN
      v_status:='ok: already amended';
    ELSIF strpos(v_source,v_old)>0 THEN
      v_status:='ok: will amend';
      v_source:=replace(v_source,v_old,v_new);
    ELSE
      v_status:='MISMATCH';
      v_first:=btrim(split_part(v_old,E'\n',1));
      v_at:=strpos(v_source,v_first);
      IF v_at=0 THEN v_at:=strpos(v_source,'ltp_followup'); END IF;
      v_live:=CASE WHEN v_at>0
        THEN replace(replace(replace(substr(v_source,greatest(v_at-40,1),length(v_old)+120),E'\r','<CR>'),E'\t','<TAB>'),E'\n','<NL>')
        ELSE 'first expected line not found anywhere in the function' END;
    END IF;
    INSERT INTO retention_flow_report VALUES(p_name,(v_index+1)/2,v_status,
      replace(replace(replace(v_old,E'\r','<CR>'),E'\t','<TAB>'),E'\n','<NL>'),v_live);
  END LOOP;
END $$;

-- ---- BEGIN substitution list from migration 031 ----

-- 3a. Legacy single-draft writers refuse sequence playbooks by kind, not key.
SELECT pg_temp.retention_flow_check('retention_create_candidate','uuid,uuid,text,text,jsonb,text,text',ARRAY[
  $old$IF p_playbook_key='ltp_followup' THEN
    RAISE EXCEPTION 'Use retention_sequence_save_batch for LTP step 1 and step 2';$old$,
  $new$IF public.retention_playbook_is_sequence(p_playbook_key) THEN
    RAISE EXCEPTION 'Use retention_sequence_save_batch for sequence playbook steps';$new$
]);
SELECT pg_temp.retention_flow_check('retention_create_draft','uuid,uuid,text,text,jsonb,text',ARRAY[
  $old$IF p_playbook_key='ltp_followup' THEN
    RAISE EXCEPTION 'Use retention_sequence_save_batch for LTP step 1 and step 2';$old$,
  $new$IF public.retention_playbook_is_sequence(p_playbook_key) THEN
    RAISE EXCEPTION 'Use retention_sequence_save_batch for sequence playbook steps';$new$
]);
SELECT pg_temp.retention_flow_check('retention_regenerate_draft','uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text',ARRAY[
  $old$IF v_key='ltp_followup' THEN$old$,
  $new$IF public.retention_playbook_is_sequence(v_key) THEN$new$
]);
SELECT pg_temp.retention_flow_check('retention_manual_edit_candidate','uuid,uuid,text,text,jsonb,timestamptz',ARRAY[
  $old$IF v_key='ltp_followup' THEN$old$,
  $new$IF public.retention_playbook_is_sequence(v_key) THEN$new$
]);
SELECT pg_temp.retention_flow_check('retention_retry_context','uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text,uuid',ARRAY[
  $old$IF v_key='ltp_followup' THEN$old$,
  $new$IF public.retention_playbook_is_sequence(v_key) THEN$new$
]);

-- 3b. Sequence lifecycle.
SELECT pg_temp.retention_flow_check('retention_sequence_transition','uuid,uuid,text,text,text,text',ARRAY[
  $old$IF p_playbook_key IS DISTINCT FROM 'ltp_followup'
     OR p_status IS NULL$old$,
  $new$IF NOT public.retention_playbook_is_sequence(p_playbook_key)
     OR p_status IS NULL$new$
]);
SELECT pg_temp.retention_flow_check('retention_sequence_player_optout_changed','',ARRAY[
  $old$SELECT s.club_id,s.player_id
      FROM public.retention_sequences s
      WHERE s.club_id=NEW.club_id AND s.player_id=NEW.id
        AND s.playbook_key='ltp_followup'
      ORDER BY s.id$old$,
  $new$SELECT s.club_id,s.player_id,s.playbook_key
      FROM public.retention_sequences s
      WHERE s.club_id=NEW.club_id AND s.player_id=NEW.id
        AND public.retention_playbook_is_sequence(s.playbook_key)
      ORDER BY s.id$new$,
  $old$v_root.club_id,v_root.player_id,'ltp_followup','exited_opt_out','player_opted_out',NULL$old$,
  $new$v_root.club_id,v_root.player_id,v_root.playbook_key,'exited_opt_out','player_opted_out',NULL$new$
]);
SELECT pg_temp.retention_flow_check('retention_sequence_session_changed','uuid,uuid,timestamptz',ARRAY[
  $old$IF NOT FOUND OR c.playbook_key IS DISTINCT FROM 'ltp_followup' THEN$old$,
  $new$IF NOT FOUND OR NOT public.retention_playbook_is_sequence(c.playbook_key) THEN$new$
]);
SELECT pg_temp.retention_flow_check('retention_sequence_due_step2','uuid',ARRAY[
  $old$WHERE s.club_id=p_club_id AND s.playbook_key='ltp_followup'$old$,
  $new$WHERE s.club_id=p_club_id AND p.flow_kind='sequence'$new$
]);

-- 3c. The transactional writer (and its 015 test clone): one playbook per
--     batch, rules read from that playbook row.
DO $migration$
DECLARE v_name text; v_pairs text[];
BEGIN
  v_pairs:=ARRAY[
    $old$DECLARE
  v_item jsonb;$old$,
    $new$DECLARE
  v_playbook_key text;
  v_playbook public.retention_playbooks%ROWTYPE;
  v_item jsonb;$new$,
    $old$WHERE x->>'playbook_key'<>'ltp_followup'
      OR x->>'operation' NOT IN ('create','regenerate','reshuffle','retry_context')$old$,
    $new$WHERE NOT public.retention_playbook_is_sequence(x->>'playbook_key')
      OR x->>'operation' NOT IN ('create','regenerate','reshuffle','retry_context')$new$,
    $old$RAISE EXCEPTION 'Unsupported LTP sequence batch operation';
  END IF;$old$,
    $new$RAISE EXCEPTION 'Unsupported LTP sequence batch operation';
  END IF;
  IF (SELECT count(DISTINCT x->>'playbook_key') FROM jsonb_array_elements(p_items) x)<>1 THEN
    RAISE EXCEPTION 'A sequence batch must belong to exactly one playbook';
  END IF;
  SELECT x->>'playbook_key' INTO v_playbook_key FROM jsonb_array_elements(p_items) x LIMIT 1;$new$,
    $old$VALUES(p_club_id,v_player_id,'ltp_followup',v_item->>'trigger_event_id')$old$,
    $new$VALUES(p_club_id,v_player_id,v_playbook_key,v_item->>'trigger_event_id')$new$,
    $old$IF NOT EXISTS(SELECT 1 FROM public.retention_playbooks p WHERE p.key='ltp_followup' AND p.enabled) THEN
    RAISE EXCEPTION 'LTP follow-up playbook is not enabled';
  END IF;
  SELECT ltp_sequence_config INTO v_config FROM public.retention_playbooks WHERE key='ltp_followup';$old$,
    $new$SELECT * INTO v_playbook FROM public.retention_playbooks
    WHERE key=v_playbook_key AND enabled AND flow_kind='sequence';
  IF NOT FOUND OR NULLIF(btrim(v_playbook.trigger_program_label),'') IS NULL
     OR NULLIF(btrim(v_playbook.verified_promo_code),'') IS NULL
     OR NULLIF(btrim(v_playbook.verified_offer_phrase),'') IS NULL
     OR NULLIF(btrim(v_playbook.booking_url),'') IS NULL THEN
    RAISE EXCEPTION 'Sequence playbook % is not enabled or lacks flow rules',v_playbook_key;
  END IF;
  v_config:=v_playbook.ltp_sequence_config;$new$,
    $old$playbook_key='ltp_followup'$old$,
    $new$playbook_key=v_playbook_key$new$,
    $old$OR v_candidate.playbook_key IS DISTINCT FROM 'ltp_followup'$old$,
    $new$OR v_candidate.playbook_key IS DISTINCT FROM v_playbook_key$new$,
    $old$v_candidate_id,p_club_id,v_player_id,'ltp_followup',v_item->>'trigger_event_id',v_context,v_status,$old$,
    $new$v_candidate_id,p_club_id,v_player_id,v_playbook_key,v_item->>'trigger_event_id',v_context,v_status,$new$,
    $old$IF position('Learn to Play' IN v_item->>'body')=0
           OR position(v_context->'ltp_text'->>'ltp_date' IN v_item->>'body')=0
           OR position('LTPNEXT25' IN v_item->>'body')=0
           OR v_context->'promo'->>'code' IS DISTINCT FROM 'LTPNEXT25'
           OR position('25%' IN COALESCE(v_context->'promo'->>'offer_text',''))=0
            OR position('25% off' IN lower(COALESCE(v_context->'promo'->>'offer_text','')))=0
            OR position('25% off' IN lower(v_item->>'body'))=0
           OR NULLIF(v_context->>'coupon_warning','') IS NOT NULL THEN
          RAISE EXCEPTION 'Step 1 requires live-verified Learn to Play and LTPNEXT25';$old$,
    $new$IF position(v_playbook.trigger_program_label IN v_item->>'body')=0
           OR position(v_context->'ltp_text'->>'ltp_date' IN v_item->>'body')=0
           OR position(v_playbook.verified_promo_code IN v_item->>'body')=0
           OR v_context->'promo'->>'code' IS DISTINCT FROM v_playbook.verified_promo_code
           OR position(lower(v_playbook.verified_offer_phrase) IN lower(COALESCE(v_context->'promo'->>'offer_text','')))=0
           OR position(lower(v_playbook.verified_offer_phrase) IN lower(v_item->>'body'))=0
           OR NULLIF(v_context->>'coupon_warning','') IS NOT NULL THEN
          RAISE EXCEPTION 'Step 1 requires the live-verified % and %',v_playbook.trigger_program_label,v_playbook.verified_promo_code;$new$,
    $old$OR upper(v_item->>'body') LIKE '%LTPNEXT25%'$old$,
    $new$OR position(upper(v_playbook.verified_promo_code) IN upper(v_item->>'body'))>0$new$,
    $old$IF position('https://pbclub.podplay.app' IN v_item->>'body')=0
           OR right(v_item->>'body',length('https://pbclub.podplay.app'))<>'https://pbclub.podplay.app'
           OR COALESCE(v_context->>'booking_url','')<>'https://pbclub.podplay.app' THEN$old$,
    $new$IF position(v_playbook.booking_url IN v_item->>'body')=0
           OR right(v_item->>'body',length(v_playbook.booking_url))<>v_playbook.booking_url
           OR COALESCE(v_context->>'booking_url','')<>v_playbook.booking_url THEN$new$
  ];
  PERFORM pg_temp.retention_flow_check('retention_sequence_save_batch','uuid,jsonb',v_pairs,true);
  PERFORM pg_temp.retention_flow_check('retention_sequence_save_batch_test','uuid,jsonb',v_pairs,false);
END $migration$;

-- 3d. Dispatch claim and send recording (and their 015 test clones).
DO $migration$
DECLARE v_pairs text[];
BEGIN
  v_pairs:=ARRAY[
    $old$IF NOT FOUND OR c.playbook_key IS DISTINCT FROM 'ltp_followup'
     OR c.step NOT IN (1,2)$old$,
    $new$IF NOT FOUND OR NOT public.retention_playbook_is_sequence(c.playbook_key)
     OR c.step NOT IN (1,2)$new$,
    $old$OR s.playbook_key IS DISTINCT FROM 'ltp_followup'
     OR s.sequence_status IS DISTINCT FROM 'active'$old$,
    $new$OR s.playbook_key IS DISTINCT FROM c.playbook_key
     OR s.sequence_status IS DISTINCT FROM 'active'$new$,
    $old$FROM public.retention_playbooks p WHERE p.key='ltp_followup'))$old$,
    $new$FROM public.retention_playbooks p WHERE p.key=c.playbook_key))$new$
  ];
  PERFORM pg_temp.retention_flow_check('retention_sequence_claim','uuid,uuid,uuid,text,timestamptz,jsonb,timestamptz',v_pairs,true);
  PERFORM pg_temp.retention_flow_check('retention_sequence_claim_test','uuid,uuid,uuid,text,timestamptz,jsonb,timestamptz',v_pairs,false);
  v_pairs:=ARRAY[
    $old$WHERE candidate.playbook_key='ltp_followup' AND candidate.club_id=p_club_id$old$,
    $new$WHERE public.retention_playbook_is_sequence(candidate.playbook_key) AND candidate.club_id=p_club_id$new$,
    $old$OR s.playbook_key IS DISTINCT FROM 'ltp_followup' THEN$old$,
    $new$OR s.playbook_key IS DISTINCT FROM c.playbook_key THEN$new$
  ];
  PERFORM pg_temp.retention_flow_check('retention_sequence_record_send','uuid,uuid,text',v_pairs,true);
  PERFORM pg_temp.retention_flow_check('retention_sequence_record_send_test','uuid,uuid,text',v_pairs,false);
END $migration$;

-- 3e. Operator approval re-validates step text against the playbook's rules.
SELECT pg_temp.retention_flow_check('retention_update_candidate','uuid,uuid,text,text,text,timestamptz',ARRAY[
  $old$m public.messages%ROWTYPE; result jsonb;
BEGIN$old$,
  $new$m public.messages%ROWTYPE; result jsonb; pb public.retention_playbooks%ROWTYPE;
BEGIN$new$,
  $old$IF NOT FOUND OR c.playbook_key IS DISTINCT FROM 'ltp_followup' THEN
    RETURN public.retention_update_candidate_legacy($old$,
  $new$IF NOT FOUND OR NOT public.retention_playbook_is_sequence(c.playbook_key) THEN
    RETURN public.retention_update_candidate_legacy($new$,
  $old$SELECT * INTO s FROM public.retention_sequences WHERE id=c.sequence_id FOR UPDATE;
  IF NOT FOUND OR s.sequence_status IS DISTINCT FROM 'active'
     OR c.sequence_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Only an active LTP sequence may be reviewed';
  END IF;$old$,
  $new$SELECT * INTO s FROM public.retention_sequences WHERE id=c.sequence_id FOR UPDATE;
  IF NOT FOUND OR s.sequence_status IS DISTINCT FROM 'active'
     OR c.sequence_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Only an active LTP sequence may be reviewed';
  END IF;
  SELECT * INTO pb FROM public.retention_playbooks WHERE key=c.playbook_key;
  IF NOT FOUND OR NULLIF(btrim(pb.trigger_program_label),'') IS NULL
     OR NULLIF(btrim(pb.verified_promo_code),'') IS NULL
     OR NULLIF(btrim(pb.verified_offer_phrase),'') IS NULL
     OR NULLIF(btrim(pb.booking_url),'') IS NULL THEN
    RAISE EXCEPTION 'Sequence playbook % lacks flow rules',c.playbook_key;
  END IF;$new$,
  $old$IF c.step=1 AND (
      position('Learn to Play' IN m.body)=0
      OR position(c.context->'ltp_text'->>'ltp_date' IN m.body)=0
      OR position('LTPNEXT25' IN m.body)=0
      OR c.context->'promo'->>'code' IS DISTINCT FROM 'LTPNEXT25'
      OR position('25%' IN COALESCE(c.context->'promo'->>'offer_text',''))=0
       OR position('25% off' IN lower(COALESCE(c.context->'promo'->>'offer_text','')))=0
       OR position('25% off' IN lower(m.body))=0
      OR NULLIF(c.context->>'coupon_warning','') IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Step 1 lost its verified Learn to Play date or 25%% offer';$old$,
  $new$IF c.step=1 AND (
      position(pb.trigger_program_label IN m.body)=0
      OR position(c.context->'ltp_text'->>'ltp_date' IN m.body)=0
      OR position(pb.verified_promo_code IN m.body)=0
      OR c.context->'promo'->>'code' IS DISTINCT FROM pb.verified_promo_code
      OR position(lower(pb.verified_offer_phrase) IN lower(COALESCE(c.context->'promo'->>'offer_text','')))=0
      OR position(lower(pb.verified_offer_phrase) IN lower(m.body))=0
      OR NULLIF(c.context->>'coupon_warning','') IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Step 1 lost its verified % date or % offer',pb.trigger_program_label,pb.verified_offer_phrase;$new$,
  $old$OR upper(m.body) LIKE '%LTPNEXT25%'$old$,
  $new$OR position(upper(pb.verified_promo_code) IN upper(m.body))>0$new$,
  $old$IF right(m.body,length('https://pbclub.podplay.app'))<>'https://pbclub.podplay.app' THEN$old$,
  $new$IF right(m.body,length(pb.booking_url))<>pb.booking_url THEN$new$
]);

-- 3f. Inbound STOP/reply (028's six-argument capture) exits or pauses every
--     sequence playbook the player is in, not only ltp_followup.
SELECT pg_temp.retention_flow_check('capture_sms_inbound','text,text,text,text,text,text',ARRAY[
  $old$event_id uuid; event_created boolean:=false; mismatch boolean:=false;
BEGIN$old$,
  $new$event_id uuid; event_created boolean:=false; mismatch boolean:=false; seq record;
BEGIN$new$,
  $old$IF EXISTS(SELECT 1 FROM public.retention_sequences WHERE club_id=club AND player_id=r.player_id
            AND playbook_key='ltp_followup' AND (r.kind='stop' OR sequence_status='active')) THEN
            PERFORM public.retention_sequence_transition(club,r.player_id,'ltp_followup',
              CASE WHEN r.kind='stop' THEN 'exited_opt_out' ELSE 'paused_reply' END,
              CASE WHEN r.kind='stop' THEN 'inbound_stop' ELSE 'inbound_reply' END,NULL);
          END IF;$old$,
  $new$FOR seq IN SELECT playbook_key FROM public.retention_sequences WHERE club_id=club AND player_id=r.player_id
            AND public.retention_playbook_is_sequence(playbook_key) AND (r.kind='stop' OR sequence_status='active')
            ORDER BY id LOOP
            PERFORM public.retention_sequence_transition(club,r.player_id,seq.playbook_key,
              CASE WHEN r.kind='stop' THEN 'exited_opt_out' ELSE 'paused_reply' END,
              CASE WHEN r.kind='stop' THEN 'inbound_stop' ELSE 'inbound_reply' END,NULL);
          END LOOP;$new$
]);

-- ---- END substitution list ----

DROP FUNCTION pg_temp.retention_flow_check(text,text,text[],boolean);

SELECT function_name, pair, status, expected_text, live_text
FROM retention_flow_report
ORDER BY (status LIKE 'MISMATCH%') DESC, function_name, pair;

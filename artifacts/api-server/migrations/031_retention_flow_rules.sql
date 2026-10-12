-- Retention engine generalization, slice 2: flow rules live on the playbook row.
-- Run this file MANUALLY in the existing Supabase project's SQL Editor, after
-- 013-030. Never run it from application code.
--
-- Before this migration the sequence RPCs from 013 (and the amendments in 015,
-- 018 and 028) branch on the literal playbook key 'ltp_followup' and validate
-- the literal strings 'Learn to Play', 'LTPNEXT25', '25% off' and the PB Club
-- booking URL inside step texts. After it, every one of those rules is read
-- from new columns on public.retention_playbooks, so a second sequence flow is
-- a playbook row, not a migration.
--
-- Behavior for the existing ltp_followup playbook is unchanged: its row is
-- seeded with exactly the values the functions used to hard-code. Installation
-- creates no drafts, approvals, sends, or schedule changes. Reinstallation is
-- safe: every function amendment is skipped when already present.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Flow rules on the playbook row.
-- ---------------------------------------------------------------------------
ALTER TABLE public.retention_playbooks
  ADD COLUMN IF NOT EXISTS flow_kind text NOT NULL DEFAULT 'single',
  ADD COLUMN IF NOT EXISTS trigger_program_label text,
  ADD COLUMN IF NOT EXISTS verified_promo_code text,
  ADD COLUMN IF NOT EXISTS verified_offer_phrase text,
  ADD COLUMN IF NOT EXISTS booking_url text;

COMMENT ON COLUMN public.retention_playbooks.flow_kind IS
  'single: one legacy draft per player. sequence: multi-step code-filled texts through retention_sequences.';
COMMENT ON COLUMN public.retention_playbooks.trigger_program_label IS
  'Program name a step-1 text must mention verbatim (sequence flows only).';
COMMENT ON COLUMN public.retention_playbooks.verified_promo_code IS
  'The only coupon a step-1 text may carry; later steps must not mention it (sequence flows only).';
COMMENT ON COLUMN public.retention_playbooks.verified_offer_phrase IS
  'Offer wording, case-insensitive, required in the verified offer text and the step-1 body (sequence flows only).';
COMMENT ON COLUMN public.retention_playbooks.booking_url IS
  'Generic booking page a no-program text must end with (sequence flows only).';

UPDATE public.retention_playbooks
SET flow_kind='sequence',
    trigger_program_label=COALESCE(trigger_program_label,'Learn to Play'),
    verified_promo_code=COALESCE(verified_promo_code,'LTPNEXT25'),
    verified_offer_phrase=COALESCE(verified_offer_phrase,'25% off'),
    booking_url=COALESCE(booking_url,'https://pbclub.podplay.app')
WHERE key='ltp_followup';

ALTER TABLE public.retention_playbooks DROP CONSTRAINT IF EXISTS retention_playbooks_flow_kind_check;
ALTER TABLE public.retention_playbooks ADD CONSTRAINT retention_playbooks_flow_kind_check
  CHECK (flow_kind IN ('single','sequence'));

-- Replaces 013's retention_playbooks_ltp_sequence_gap_check, keyed on the flow
-- kind instead of the key. A sequence playbook must carry complete rules.
ALTER TABLE public.retention_playbooks DROP CONSTRAINT IF EXISTS retention_playbooks_ltp_sequence_gap_check;
ALTER TABLE public.retention_playbooks DROP CONSTRAINT IF EXISTS retention_playbooks_sequence_flow_check;
ALTER TABLE public.retention_playbooks ADD CONSTRAINT retention_playbooks_sequence_flow_check CHECK (
  flow_kind<>'sequence' OR (
    NULLIF(btrim(trigger_program_label),'') IS NOT NULL
    AND NULLIF(btrim(verified_promo_code),'') IS NOT NULL
    AND verified_promo_code !~ '[[:space:]]'
    AND NULLIF(btrim(verified_offer_phrase),'') IS NOT NULL
    AND booking_url ~ '^https://[^[:space:]]+$'
    AND jsonb_typeof(ltp_sequence_config->'step2_gap_days')='number'
    AND (ltp_sequence_config->>'step2_gap_days')::numeric BETWEEN 7 AND 30
    AND trunc((ltp_sequence_config->>'step2_gap_days')::numeric)
      =(ltp_sequence_config->>'step2_gap_days')::numeric
  )
);

CREATE OR REPLACE FUNCTION public.retention_playbook_is_sequence(p_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.retention_playbooks WHERE key=p_key AND flow_kind='sequence')
$$;
REVOKE ALL ON FUNCTION public.retention_playbook_is_sequence(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retention_playbook_is_sequence(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Candidate identity: a CHECK cannot read another table, so the rule that
--    "sequence playbooks always have a sequence root; single playbooks never
--    do" moves from 013's literal-keyed CHECK to a row trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_candidates_sequence_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF public.retention_playbook_is_sequence(NEW.playbook_key) THEN
    IF NEW.sequence_id IS NULL THEN
      RAISE EXCEPTION 'Candidates of sequence playbook % require a sequence root',NEW.playbook_key;
    END IF;
  ELSIF NEW.step IS DISTINCT FROM 1 OR NEW.sequence_id IS NOT NULL
     OR NEW.sequence_status IS DISTINCT FROM 'active' OR NEW.exited_at IS NOT NULL
     OR NEW.exit_reason IS NOT NULL OR NEW.booked_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'Candidates of single-draft playbook % cannot carry sequence state',NEW.playbook_key;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.retention_candidates_sequence_identity()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.retention_candidates_sequence_identity() TO service_role;

DO $$
BEGIN
  -- Every existing row must satisfy the generalized rule before the literal
  -- CHECK is dropped; the seeded ltp_followup row makes this equivalent.
  IF EXISTS(
    SELECT 1 FROM public.retention_candidates c
    WHERE (public.retention_playbook_is_sequence(c.playbook_key) AND c.sequence_id IS NULL)
       OR (NOT public.retention_playbook_is_sequence(c.playbook_key) AND (
         c.step IS DISTINCT FROM 1 OR c.sequence_id IS NOT NULL
         OR c.sequence_status IS DISTINCT FROM 'active' OR c.exited_at IS NOT NULL
         OR c.exit_reason IS NOT NULL OR c.booked_event_id IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'Existing retention_candidates rows violate the flow-kind identity rule; inspect before installing';
  END IF;
  ALTER TABLE public.retention_candidates DROP CONSTRAINT IF EXISTS retention_candidates_ltp_sequence_identity_check;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.retention_candidates'::regclass
      AND tgname='retention_candidates_sequence_identity' AND NOT tgisinternal) THEN
    EXECUTE 'CREATE TRIGGER retention_candidates_sequence_identity
      BEFORE INSERT OR UPDATE OF playbook_key,step,sequence_id,sequence_status,exited_at,exit_reason,booked_event_id
      ON public.retention_candidates FOR EACH ROW
      EXECUTE FUNCTION public.retention_candidates_sequence_identity()';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Amend the installed functions in place. Each pair is (old text, new
--    text). An amendment already present is skipped; text that is neither the
--    old nor the new form fails the install so drift is inspected, not patched
--    blindly. This is the same technique migrations 015 and 018 use. The new
--    form is checked first: some new texts contain their old text, and a
--    re-run must not insert them twice.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.retention_flow_amend(p_name text,p_signature text,p_pairs text[],p_required boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_proc regprocedure; v_source text; v_amended text; v_index integer; v_old text; v_new text;
BEGIN
  v_proc:=to_regprocedure('public.'||p_name||'('||p_signature||')');
  IF v_proc IS NULL THEN
    IF p_required THEN RAISE EXCEPTION 'Install migrations 013-030 first: % is missing',p_name; END IF;
    RETURN;
  END IF;
  v_source:=pg_get_functiondef(v_proc);
  v_amended:=v_source;
  FOR v_index IN 1..array_length(p_pairs,1) BY 2 LOOP
    v_old:=p_pairs[v_index]; v_new:=p_pairs[v_index+1];
    IF strpos(v_amended,v_new)>0 THEN
      CONTINUE;
    ELSIF strpos(v_amended,v_old)>0 THEN
      v_amended:=replace(v_amended,v_old,v_new);
    ELSE
      RAISE EXCEPTION 'Unexpected % source; inspect before installing. Missing: %',p_name,left(v_old,100);
    END IF;
  END LOOP;
  IF v_amended<>v_source THEN EXECUTE v_amended; END IF;
END $$;

-- 3a. Legacy single-draft writers refuse sequence playbooks by kind, not key.
SELECT pg_temp.retention_flow_amend('retention_create_candidate','uuid,uuid,text,text,jsonb,text,text',ARRAY[
  $old$IF p_playbook_key='ltp_followup' THEN
    RAISE EXCEPTION 'Use retention_sequence_save_batch for LTP step 1 and step 2';$old$,
  $new$IF public.retention_playbook_is_sequence(p_playbook_key) THEN
    RAISE EXCEPTION 'Use retention_sequence_save_batch for sequence playbook steps';$new$
]);
SELECT pg_temp.retention_flow_amend('retention_create_draft','uuid,uuid,text,text,jsonb,text',ARRAY[
  $old$IF p_playbook_key='ltp_followup' THEN
    RAISE EXCEPTION 'Use retention_sequence_save_batch for LTP step 1 and step 2';$old$,
  $new$IF public.retention_playbook_is_sequence(p_playbook_key) THEN
    RAISE EXCEPTION 'Use retention_sequence_save_batch for sequence playbook steps';$new$
]);
SELECT pg_temp.retention_flow_amend('retention_regenerate_draft','uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text',ARRAY[
  $old$IF v_key='ltp_followup' THEN$old$,
  $new$IF public.retention_playbook_is_sequence(v_key) THEN$new$
]);
SELECT pg_temp.retention_flow_amend('retention_manual_edit_candidate','uuid,uuid,text,text,jsonb,timestamptz',ARRAY[
  $old$IF v_key='ltp_followup' THEN$old$,
  $new$IF public.retention_playbook_is_sequence(v_key) THEN$new$
]);
SELECT pg_temp.retention_flow_amend('retention_retry_context','uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text,uuid',ARRAY[
  $old$IF v_key='ltp_followup' THEN$old$,
  $new$IF public.retention_playbook_is_sequence(v_key) THEN$new$
]);

-- 3b. Sequence lifecycle.
SELECT pg_temp.retention_flow_amend('retention_sequence_transition','uuid,uuid,text,text,text,text',ARRAY[
  $old$IF p_playbook_key IS DISTINCT FROM 'ltp_followup'
     OR p_status IS NULL$old$,
  $new$IF NOT public.retention_playbook_is_sequence(p_playbook_key)
     OR p_status IS NULL$new$
]);
SELECT pg_temp.retention_flow_amend('retention_sequence_player_optout_changed','',ARRAY[
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
SELECT pg_temp.retention_flow_amend('retention_sequence_session_changed','uuid,uuid,timestamptz',ARRAY[
  $old$IF NOT FOUND OR c.playbook_key IS DISTINCT FROM 'ltp_followup' THEN$old$,
  $new$IF NOT FOUND OR NOT public.retention_playbook_is_sequence(c.playbook_key) THEN$new$
]);
SELECT pg_temp.retention_flow_amend('retention_sequence_due_step2','uuid',ARRAY[
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
  PERFORM pg_temp.retention_flow_amend('retention_sequence_save_batch','uuid,jsonb',v_pairs,true);
  PERFORM pg_temp.retention_flow_amend('retention_sequence_save_batch_test','uuid,jsonb',v_pairs,false);
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
  PERFORM pg_temp.retention_flow_amend('retention_sequence_claim','uuid,uuid,uuid,text,timestamptz,jsonb,timestamptz',v_pairs,true);
  PERFORM pg_temp.retention_flow_amend('retention_sequence_claim_test','uuid,uuid,uuid,text,timestamptz,jsonb,timestamptz',v_pairs,false);
  v_pairs:=ARRAY[
    $old$WHERE candidate.playbook_key='ltp_followup' AND candidate.club_id=p_club_id$old$,
    $new$WHERE public.retention_playbook_is_sequence(candidate.playbook_key) AND candidate.club_id=p_club_id$new$,
    $old$OR s.playbook_key IS DISTINCT FROM 'ltp_followup' THEN$old$,
    $new$OR s.playbook_key IS DISTINCT FROM c.playbook_key THEN$new$
  ];
  PERFORM pg_temp.retention_flow_amend('retention_sequence_record_send','uuid,uuid,text',v_pairs,true);
  PERFORM pg_temp.retention_flow_amend('retention_sequence_record_send_test','uuid,uuid,text',v_pairs,false);
END $migration$;

-- 3e. Operator approval re-validates step text against the playbook's rules.
SELECT pg_temp.retention_flow_amend('retention_update_candidate','uuid,uuid,text,text,text,timestamptz',ARRAY[
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
SELECT pg_temp.retention_flow_amend('capture_sms_inbound','text,text,text,text,text,text',ARRAY[
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

DROP FUNCTION pg_temp.retention_flow_amend(text,text,text[],boolean);

-- ---------------------------------------------------------------------------
-- 4. Readiness: same signature as 013, now keyed on the trigger and on every
--    sequence playbook carrying complete rules.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_sequence_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT public.retention_schema_ready()
    AND public.retention_context_retry_ready()
    AND to_regprocedure('public.retention_sequence_save_batch(uuid,jsonb)') IS NOT NULL
    AND to_regprocedure('public.retention_sequence_transition(uuid,uuid,text,text,text,text)') IS NOT NULL
    AND to_regprocedure('public.retention_sequence_session_changed(uuid,uuid,timestamptz)') IS NOT NULL
    AND to_regprocedure('public.retention_sequence_claim(uuid,uuid,uuid,text,timestamptz,jsonb,timestamptz)') IS NOT NULL
    AND to_regprocedure('public.retention_sequence_record_send(uuid,uuid,text)') IS NOT NULL
    AND to_regprocedure('public.retention_sequence_due_step2(uuid)') IS NOT NULL
    AND to_regprocedure('public.retention_sequence_player_optout_changed()') IS NOT NULL
    AND to_regprocedure('public.retention_playbook_is_sequence(text)') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.players'::regclass
        AND tgname='players_ltp_retention_optout' AND NOT tgisinternal
        AND tgenabled='O'
        AND tgfoid='public.retention_sequence_player_optout_changed()'::regprocedure
    )
    AND EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.retention_candidates'::regclass
        AND tgname='retention_candidates_sequence_identity' AND NOT tgisinternal
        AND tgenabled='O'
        AND tgfoid='public.retention_candidates_sequence_identity()'::regprocedure
    )
    AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.retention_sequences'::regclass AND c.relrowsecurity)
    AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.retention_capacity_event_locks'::regclass AND c.relrowsecurity)
    AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.retention_capacity_reservations'::regclass AND c.relrowsecurity)
    AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='retention_candidates_player_playbook_step_unique')
    AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='retention_candidates_sequence_step_unique')
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid='public.retention_playbooks'::regclass
        AND conname='retention_playbooks_sequence_flow_check'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid='public.retention_candidates'::regclass
        AND conname='retention_candidates_ltp_sequence_identity_check'
    )
    AND EXISTS (SELECT 1 FROM public.retention_playbooks WHERE flow_kind='sequence')
    AND NOT EXISTS (
      SELECT 1 FROM public.retention_playbooks
      WHERE flow_kind='sequence' AND NOT (
        jsonb_typeof(ltp_sequence_config->'step1')='object'
        AND jsonb_typeof(ltp_sequence_config->'step2')='object'
        AND jsonb_typeof(ltp_sequence_config->'step2_gap_days')='number'
        AND (ltp_sequence_config->>'step2_gap_days')::numeric BETWEEN 7 AND 30
        AND trunc((ltp_sequence_config->>'step2_gap_days')::numeric)
          =(ltp_sequence_config->>'step2_gap_days')::numeric
        AND NULLIF(btrim(trigger_program_label),'') IS NOT NULL
        AND NULLIF(btrim(verified_promo_code),'') IS NOT NULL
        AND NULLIF(btrim(verified_offer_phrase),'') IS NOT NULL
        AND NULLIF(btrim(booking_url),'') IS NOT NULL
      )
    )
$$;
REVOKE ALL ON FUNCTION public.retention_sequence_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retention_sequence_ready() TO service_role;

-- No amended function may still carry the literal playbook key.
DO $$
DECLARE v_name text;
BEGIN
  FOR v_name IN SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'retention_create_candidate','retention_create_draft','retention_regenerate_draft',
      'retention_manual_edit_candidate','retention_retry_context','retention_sequence_transition',
      'retention_sequence_player_optout_changed','retention_sequence_session_changed',
      'retention_sequence_due_step2','retention_sequence_save_batch','retention_sequence_claim',
      'retention_sequence_record_send','retention_update_candidate','retention_sequence_ready'
    ) AND (strpos(pg_get_functiondef(p.oid),'''ltp_followup''')>0
        OR strpos(pg_get_functiondef(p.oid),'''LTPNEXT25''')>0)
  LOOP
    RAISE EXCEPTION 'Function % still hard-codes the LTP playbook; inspect before installing',v_name;
  END LOOP;
END $$;

COMMIT;
NOTIFY pgrst,'reload schema';

-- Read-only verification in the SAME SQL Editor after this migration commits.
SELECT public.retention_sequence_ready() AS retention_sequence_ready;
SELECT key,flow_kind,trigger_program_label,verified_promo_code,verified_offer_phrase,booking_url
FROM public.retention_playbooks ORDER BY key;

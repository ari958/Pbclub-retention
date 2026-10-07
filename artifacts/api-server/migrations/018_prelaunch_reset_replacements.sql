-- Apply manually in the existing external Supabase SQL Editor, after 013-017.
-- Installation creates no drafts, approvals, sends, or changes to settings.
-- Old candidate fields and archived messages remain intact. The only added
-- history metadata is a deferred link to the newly created replacement.
BEGIN;

ALTER TABLE public.retention_candidates
  ADD COLUMN IF NOT EXISTS prelaunch_superseded_by uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.retention_candidates'::regclass
      AND conname='retention_prelaunch_superseded_fk') THEN
    ALTER TABLE public.retention_candidates ADD CONSTRAINT retention_prelaunch_superseded_fk
      FOREIGN KEY(prelaunch_superseded_by) REFERENCES public.retention_candidates(id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- Preserve one canonical player/playbook/step and one canonical sequence/step.
-- Historical superseded candidates remain queryable by their original IDs.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname FROM pg_constraint con
    JOIN LATERAL (
      SELECT array_agg(att.attname ORDER BY key.ordinality) AS names
      FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum,ordinality)
      JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum=key.attnum
    ) cols ON true
    WHERE con.conrelid='public.retention_candidates'::regclass AND con.contype='u'
      AND (cols.names=ARRAY['player_id','playbook_key','step']::name[]
        OR cols.names=ARRAY['sequence_id','step']::name[])
  LOOP
    EXECUTE format('ALTER TABLE public.retention_candidates DROP CONSTRAINT %I',constraint_name);
  END LOOP;
END $$;
DROP INDEX IF EXISTS public.retention_candidates_player_playbook_step_unique;
DROP INDEX IF EXISTS public.retention_candidates_sequence_step_unique;
CREATE UNIQUE INDEX retention_candidates_player_playbook_step_unique
  ON public.retention_candidates(player_id,playbook_key,step)
  WHERE prelaunch_superseded_by IS NULL;
CREATE UNIQUE INDEX retention_candidates_sequence_step_unique
  ON public.retention_candidates(sequence_id,step)
  WHERE sequence_id IS NOT NULL AND prelaunch_superseded_by IS NULL;

-- Amend the installed transactional writer, keeping its capacity, text,
-- booking, opt-out, CAS, approval, and rollback safeguards. Refuse source drift.
DO $migration$
DECLARE fn text; source text; amended text;
  old_gate text := $gate$ELSIF EXISTS(SELECT 1 FROM public.retention_candidates
          WHERE sequence_id=v_sequence.id AND step=1) THEN
        RAISE EXCEPTION 'Step 1 was already created for this sequence';$gate$;
  new_gate text := $gate$ELSIF EXISTS(SELECT 1 FROM public.retention_candidates
          WHERE sequence_id=v_sequence.id AND step=1 AND prelaunch_superseded_by IS NULL) THEN
        DECLARE old_candidate public.retention_candidates%ROWTYPE;
          old_message public.messages%ROWTYPE;
        BEGIN
          IF v_sequence.step1_sent_at IS NOT NULL OR v_sequence.step1_message_id IS NOT NULL
            OR v_sequence.step1_delivery_kind IS NOT NULL
            OR v_sequence.step2_sent_at IS NOT NULL OR v_sequence.step2_message_id IS NOT NULL
            OR v_sequence.sequence_status IS DISTINCT FROM 'active'
            OR v_sequence.exited_at IS NOT NULL OR v_sequence.exit_reason IS NOT NULL THEN
            RAISE EXCEPTION 'A previously sent or stopped sequence cannot restart';
          END IF;
          IF EXISTS(SELECT 1 FROM public.contact_ledger
            WHERE player_id=v_player_id OR intended_player_id=v_player_id
              OR message_id IN(SELECT message_id FROM public.retention_candidates
                WHERE player_id=v_player_id AND playbook_key='ltp_followup')) THEN
            RAISE EXCEPTION 'Contact-ledger evidence prohibits reset replacement';
          END IF;
          -- The player and root are already locked by the batch writer.
          -- Lock the old rows in that same lock order before checking evidence.
          FOR old_candidate IN SELECT * FROM public.retention_candidates
            WHERE player_id=v_player_id AND playbook_key='ltp_followup'
              AND prelaunch_superseded_by IS NULL ORDER BY id FOR UPDATE
          LOOP
            IF old_candidate.club_id IS DISTINCT FROM p_club_id
              OR old_candidate.sequence_id IS DISTINCT FROM v_sequence.id
              OR old_candidate.step IS DISTINCT FROM 1
              OR old_candidate.trigger_event_id IS DISTINCT FROM v_item->>'trigger_event_id'
              OR old_candidate.status IS DISTINCT FROM 'skipped'
              OR old_candidate.context->>'reason' IS DISTINCT FROM 'pre_launch_reset'
              OR old_candidate.message_id IS NULL THEN
              RAISE EXCEPTION 'Step 1 was already created; only archived pre-launch resets can be replaced';
            END IF;
            SELECT * INTO old_message FROM public.messages
              WHERE id=old_candidate.message_id FOR UPDATE;
            IF NOT FOUND OR old_message.player_id IS DISTINCT FROM v_player_id
              OR old_message.status IS DISTINCT FROM 'archived'
              OR old_message.error_message IS DISTINCT FROM 'pre_launch_reset'
              OR old_message.direction IS DISTINCT FROM 'outbound'
              OR old_message.simulated IS DISTINCT FROM false
              OR old_message.approved_at IS NOT NULL OR old_message.approved_by IS NOT NULL
              OR old_message.approved_body IS NOT NULL OR old_message.scheduled_send_at IS NOT NULL
              OR old_message.sent_at IS NOT NULL OR old_message.dispatch_claimed_at IS NOT NULL
              OR old_message.dispatch_token IS NOT NULL OR old_message.twilio_message_sid IS NOT NULL
              OR old_message.delivery_status IS NOT NULL OR old_message.delivered_at IS NOT NULL
              OR old_message.retention_delivery_kind IS NOT NULL THEN
              RAISE EXCEPTION 'Archived message has approval, dispatch, or delivery evidence; replacement refused';
            END IF;
            UPDATE public.retention_candidates SET prelaunch_superseded_by=v_candidate_id
              WHERE id=old_candidate.id;
          END LOOP;
        END;$gate$;
BEGIN
  FOREACH fn IN ARRAY ARRAY['retention_sequence_save_batch','retention_sequence_save_batch_test'] LOOP
    source:=pg_get_functiondef(to_regprocedure('public.'||fn||'(uuid,jsonb)'));
    IF source IS NULL THEN RAISE EXCEPTION 'Install LTP migrations 013-016 first: %',fn; END IF;
    IF strpos(source,'prelaunch_superseded_by')>0 THEN CONTINUE; END IF;
    IF strpos(source,old_gate)=0 THEN RAISE EXCEPTION 'Unexpected step-1 writer; inspect before installing: %',fn; END IF;
    amended:=replace(source,old_gate,new_gate);
    EXECUTE amended;
  END LOOP;
END $migration$;

-- Do not propagate future sequence state changes into archived history.
-- Step-2 discovery must use the canonical first-touch candidate only.
DO $migration$
DECLARE fn record; source text; amended text;
BEGIN
  FOR fn IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'retention_sequence_transition','retention_sequence_record_send',
      'retention_sequence_record_send_test','retention_sequence_due_step2'
    ) LOOP
    source:=pg_get_functiondef(fn.oid);
    amended:=replace(source,'WHERE c.sequence_id=s.id;',
      'WHERE c.sequence_id=s.id AND c.prelaunch_superseded_by IS NULL;');
    amended:=replace(amended,
      'SET sequence_status=''completed'',updated_at=now() WHERE sequence_id=s.id;',
      'SET sequence_status=''completed'',updated_at=now() WHERE sequence_id=s.id AND prelaunch_superseded_by IS NULL;');
    amended:=replace(amended,'c.sequence_id=s.id AND c.step=1',
      'c.sequence_id=s.id AND c.step=1 AND c.prelaunch_superseded_by IS NULL');
    -- A second install must not accumulate duplicate predicates.
    IF strpos(source,'prelaunch_superseded_by')=0 AND amended<>source THEN EXECUTE amended; END IF;
  END LOOP;
END $migration$;

-- The legacy non-LTP writer uses the same player/step index. Keep its conflict
-- handling compatible with the partial index; do not change legacy eligibility.
DO $migration$
DECLARE source text; amended text;
BEGIN
  source:=pg_get_functiondef(to_regprocedure(
    'public.retention_create_candidate(uuid,uuid,text,text,jsonb,text,text)'));
  IF source IS NULL THEN RAISE EXCEPTION 'Missing legacy candidate writer'; END IF;
  amended:=replace(source,'ON CONFLICT(player_id,playbook_key,step) DO NOTHING',
    'ON CONFLICT(player_id,playbook_key,step) WHERE prelaunch_superseded_by IS NULL DO NOTHING');
  IF amended<>source THEN EXECUTE amended; END IF;
END $migration$;

CREATE OR REPLACE FUNCTION public.retention_prelaunch_reset_ready()
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM pg_attribute
    WHERE attrelid='public.retention_candidates'::regclass
      AND attname='prelaunch_superseded_by' AND NOT attisdropped)
    AND strpos(pg_get_functiondef(
      'public.retention_sequence_save_batch(uuid,jsonb)'::regprocedure),
      'only archived pre-launch resets can be replaced')>0
$$;
REVOKE ALL ON FUNCTION public.retention_prelaunch_reset_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retention_prelaunch_reset_ready() TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;

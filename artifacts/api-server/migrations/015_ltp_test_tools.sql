-- Run MANUALLY in the existing Supabase SQL Editor. Never use Replit DATABASE_URL.
-- Test controls never rewrite sent messages, original send timestamps, or real RPCs.
BEGIN;

CREATE TABLE IF NOT EXISTS public.retention_ltp_test_controls (
  sequence_id uuid PRIMARY KEY REFERENCES public.retention_sequences(id),
  club_id uuid NOT NULL,
  candidate_id uuid NOT NULL UNIQUE REFERENCES public.retention_candidates(id),
  original_sent_at timestamptz NOT NULL,
  effective_sent_at timestamptz NOT NULL,
  simulated_booking boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.retention_ltp_test_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  original_sent_at timestamptz NOT NULL,
  effective_sent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.retention_ltp_test_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_ltp_test_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.retention_ltp_test_controls,public.retention_ltp_test_audit FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.retention_ltp_test_controls TO service_role;
GRANT SELECT,INSERT ON public.retention_ltp_test_audit TO service_role;

-- Called only by the separately named, service-role-only test RPC. A
-- transaction-local guard prevents direct calls to the cloned SQL functions.
CREATE OR REPLACE FUNCTION public.retention_ltp_test_effective_time(p_sequence_id uuid)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE effective timestamptz;
BEGIN
  IF current_setting('app.ltp_test_mode',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'LTP test mode is not enabled' USING ERRCODE='42501';
  END IF;
  SELECT t.effective_sent_at INTO effective
  FROM public.retention_ltp_test_controls t
  JOIN public.retention_sequences s ON s.id=t.sequence_id AND s.club_id=t.club_id
  JOIN public.retention_candidates c ON c.id=t.candidate_id AND c.sequence_id=s.id AND c.step=1
  JOIN public.messages m ON m.id=s.step1_message_id AND m.id=c.message_id
  WHERE s.id=p_sequence_id AND s.step1_delivery_kind='test'
    AND s.step1_sent_at=t.original_sent_at
    AND m.status='sent' AND m.sent_at=t.original_sent_at
    AND m.simulated IS FALSE AND m.retention_delivery_kind='test'
    AND EXISTS(SELECT 1 FROM public.contact_ledger l WHERE l.message_id=m.id AND l.is_test IS TRUE);
  IF effective IS NULL THEN RAISE EXCEPTION 'Verified backdated test step 1 is required'; END IF;
  RETURN effective;
END $$;

-- Copy the installed transactional implementation rather than duplicating
-- capacity/CAS/text/approval safeguards. Real functions remain byte-for-byte
-- unchanged. Fail installation if the expected implementation has drifted.
DO $migration$
DECLARE name text; signature text; source text; amended text; target text;
BEGIN
  FOR name,signature IN SELECT * FROM (VALUES
    ('retention_sequence_save_batch','uuid,jsonb'),
    ('retention_sequence_claim','uuid,uuid,uuid,text,timestamptz,jsonb,timestamptz'),
    ('retention_sequence_record_send','uuid,uuid,text')
  ) AS functions(name,signature) LOOP
    source:=pg_get_functiondef(to_regprocedure('public.'||name||'('||signature||')'));
    IF source IS NULL THEN RAISE EXCEPTION 'Install migration 013 first: %',name; END IF;
    target:=name||'_test';
    amended:=replace(source,'public.'||name||'(', 'public.'||target||'(');
    IF name='retention_sequence_save_batch' THEN
      IF strpos(source,'v_sequence.step1_delivery_kind IS DISTINCT FROM ''real''')=0
        OR strpos(source,'now()-v_sequence.step1_sent_at')=0 THEN
        RAISE EXCEPTION 'Unexpected save-batch implementation; inspect before installing';
      END IF;
      amended:=replace(amended,'v_sequence.step1_delivery_kind IS DISTINCT FROM ''real''',
        'v_sequence.step1_delivery_kind IS DISTINCT FROM ''test''');
      amended:=replace(amended,'now()-v_sequence.step1_sent_at',
        'now()-public.retention_ltp_test_effective_time(v_sequence.id)');
      IF strpos(source,'INSERT INTO public.messages(player_id,body,direction,sent_by,status,sent_at)')>0
        AND strpos(source,'''outbound'',''agent'',''pending'',NULL)')>0 THEN
        NULL; -- Source already creates unsent drafts explicitly.
      ELSIF strpos(source,'INSERT INTO public.messages(player_id,body,direction,sent_by,status)')=0
        OR strpos(source,'''outbound'',''agent'',''pending'')')=0 THEN
        RAISE EXCEPTION 'Unexpected draft insertion; inspect before installing';
      END IF;
      -- Some legacy messages schemas default sent_at to now(), even for pending
      -- drafts. Override that default in the test clone, not in real RPCs.
      amended:=replace(amended,'INSERT INTO public.messages(player_id,body,direction,sent_by,status)',
        'INSERT INTO public.messages(player_id,body,direction,sent_by,status,sent_at)');
      amended:=replace(amended,'''outbound'',''agent'',''pending'')',
        '''outbound'',''agent'',''pending'',NULL)');
    ELSIF name='retention_sequence_claim' THEN
      IF strpos(source,'s.step1_delivery_kind IS DISTINCT FROM ''real''')=0 THEN
        RAISE EXCEPTION 'Unexpected claim implementation; inspect before installing';
      END IF;
      amended:=replace(amended,'s.step1_delivery_kind IS DISTINCT FROM ''real''',
        's.step1_delivery_kind IS DISTINCT FROM ''test''');
      amended:=replace(amended,'now()-s.step1_sent_at',
        'now()-public.retention_ltp_test_effective_time(s.id)');
    ELSE
      IF strpos(source,'p_delivery_kind=''real'' AND')=0 THEN
        RAISE EXCEPTION 'Unexpected record-send implementation; inspect before installing';
      END IF;
      -- Accepted/queued test sends are NOT completion. Require provider delivery.
      amended:=replace(amended,'p_delivery_kind=''real'' AND',
        'p_delivery_kind=''test'' AND m.delivery_status=''delivered'' AND m.delivered_at IS NOT NULL AND');
    END IF;
    IF amended=source THEN RAISE EXCEPTION 'Test function was not generated: %',name; END IF;
    EXECUTE amended;
    EXECUTE 'REVOKE ALL ON FUNCTION public.'||target||'('||signature||') FROM PUBLIC,anon,authenticated,service_role';
  END LOOP;
END $migration$;

CREATE OR REPLACE FUNCTION public.retention_ltp_test_rpc(
  p_club_id uuid,p_operation text,p_payload jsonb,p_override_enabled boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.retention_candidates%ROWTYPE; s public.retention_sequences%ROWTYPE;
  t public.retention_ltp_test_controls%ROWTYPE; m public.messages%ROWTYPE;
  original timestamptz; effective timestamptz; actor text; result jsonb; item jsonb;
  audit_sequence uuid; override_digits text; sent_count integer;
BEGIN
  IF p_operation='backdate' THEN
    actor:=btrim(p_payload->>'actor');
    SELECT sequence_id INTO audit_sequence FROM public.retention_candidates
      WHERE id=(p_payload->>'candidate_id')::uuid AND club_id=p_club_id;
    RAISE LOG 'LTP backdate attempt sequence=% operator=%',audit_sequence,actor;
  END IF;
  IF p_override_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMS_TEST_OVERRIDE_TO is required' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('app.ltp_test_mode','on',true);
  IF p_operation IN ('backdate','simulate_booking') THEN
    actor:=btrim(p_payload->>'actor');
    IF actor IS NULL OR length(actor)<1 OR length(actor)>120 THEN RAISE EXCEPTION 'Actor is required'; END IF;
    SELECT * INTO c FROM public.retention_candidates
      WHERE id=(p_payload->>'candidate_id')::uuid AND club_id=p_club_id AND step=1 AND playbook_key='ltp_followup' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Test step-1 candidate not found'; END IF;
    SELECT * INTO s FROM public.retention_sequences WHERE id=c.sequence_id AND club_id=p_club_id FOR UPDATE;
    SELECT * INTO m FROM public.messages WHERE id=c.message_id FOR UPDATE;
    IF s.sequence_status IS DISTINCT FROM 'active' OR c.status IS DISTINCT FROM 'sent'
      OR s.step1_message_id IS DISTINCT FROM m.id OR s.step1_delivery_kind IS DISTINCT FROM 'test'
      OR m.retention_delivery_kind IS DISTINCT FROM 'test' OR m.status IS DISTINCT FROM 'sent'
      OR m.simulated IS DISTINCT FROM false OR m.sent_at IS NULL
      OR s.step1_sent_at IS DISTINCT FROM m.sent_at
      OR NOT EXISTS(SELECT 1 FROM public.contact_ledger l WHERE l.message_id=m.id AND l.is_test IS TRUE) THEN
      RAISE EXCEPTION 'Only a verified actual test step-1 send in an active sequence may be changed';
    END IF;
    original:=m.sent_at;
    effective:=original-make_interval(days=>(SELECT (ltp_sequence_config->>'step2_gap_days')::integer
      FROM public.retention_playbooks WHERE key='ltp_followup'));
    IF effective IS NULL THEN RAISE EXCEPTION 'Step-2 gap is missing'; END IF;
    IF p_operation='backdate' THEN
      -- Trusted service wrapper reads each destination from Twilio's stored
      -- outbound record. Check complete SID-bound evidence under row locks.
      audit_sequence:=s.id;
      override_digits:=regexp_replace(COALESCE(p_payload->>'override_to',''),'[^0-9]','','g');
      IF length(override_digits)=10 THEN override_digits:='1'||override_digits; END IF;
      IF override_digits !~ '^[0-9]{11,15}$'
        OR p_payload->>'destination_evidence_source' IS DISTINCT FROM 'twilio_stored'
        OR jsonb_typeof(p_payload->'verified_destinations') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Stored override destinations are required' USING ERRCODE='42501';
      END IF;
      IF (s.step1_sent_at IS NOT NULL AND s.step1_message_id IS NULL)
        OR (s.step2_sent_at IS NOT NULL AND s.step2_message_id IS NULL) THEN
        RAISE EXCEPTION 'A sent step has no message evidence' USING ERRCODE='42501';
      END IF;
      PERFORM 1 FROM public.messages sm WHERE sm.id IN (s.step1_message_id,s.step2_message_id)
        OR sm.id IN (SELECT message_id FROM public.retention_candidates WHERE sequence_id=s.id AND club_id=p_club_id)
        FOR UPDATE;
      SELECT count(*) INTO sent_count FROM public.messages sm
        WHERE (sm.id IN (s.step1_message_id,s.step2_message_id)
          OR sm.id IN (SELECT message_id FROM public.retention_candidates WHERE sequence_id=s.id AND club_id=p_club_id))
          AND (sm.status='sent' OR sm.id=s.step1_message_id OR (s.step2_sent_at IS NOT NULL AND sm.id=s.step2_message_id));
      IF sent_count=0 OR jsonb_array_length(p_payload->'verified_destinations')<>sent_count
        OR EXISTS(SELECT 1 FROM public.messages sm
          WHERE (sm.id IN (s.step1_message_id,s.step2_message_id)
            OR sm.id IN (SELECT message_id FROM public.retention_candidates WHERE sequence_id=s.id AND club_id=p_club_id))
            AND (sm.status='sent' OR sm.id=s.step1_message_id OR (s.step2_sent_at IS NOT NULL AND sm.id=s.step2_message_id))
            AND (sm.status IS DISTINCT FROM 'sent' OR sm.sent_at IS NULL OR sm.twilio_message_sid IS NULL
              OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'verified_destinations') evidence
                WHERE evidence->>'message_id'=sm.id::text
                  AND evidence->>'twilio_message_sid'=sm.twilio_message_sid
                  AND regexp_replace(COALESCE(evidence->>'to',''),'[^0-9]','','g')=override_digits))) THEN
        RAISE EXCEPTION 'Every sent message must match the stored override destination' USING ERRCODE='42501';
      END IF;
      IF EXISTS(SELECT 1 FROM public.retention_candidates WHERE sequence_id=s.id AND step=2) THEN
        RAISE EXCEPTION 'Step 2 already exists; cannot change eligibility';
      END IF;
      INSERT INTO public.retention_ltp_test_controls(sequence_id,club_id,candidate_id,original_sent_at,effective_sent_at)
        VALUES(s.id,p_club_id,c.id,original,effective) ON CONFLICT(sequence_id) DO NOTHING;
    ELSE
      IF NOT EXISTS(SELECT 1 FROM public.retention_candidates c2 JOIN public.messages m2 ON m2.id=c2.message_id
        WHERE c2.sequence_id=s.id AND c2.step=2 AND c2.status='drafted' AND m2.status='pending'
          AND m2.approved_at IS NULL AND m2.scheduled_send_at IS NULL AND m2.sent_at IS NULL) THEN
        RAISE EXCEPTION 'An unapproved step-2 draft must exist before simulating booking';
      END IF;
      UPDATE public.retention_ltp_test_controls SET simulated_booking=true
        WHERE sequence_id=s.id AND club_id=p_club_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Backdate the test sequence first'; END IF;
    END IF;
    SELECT * INTO t FROM public.retention_ltp_test_controls WHERE sequence_id=s.id;
    INSERT INTO public.retention_ltp_test_audit(club_id,candidate_id,actor,action,original_sent_at,effective_sent_at)
      VALUES(p_club_id,c.id,actor,p_operation,t.original_sent_at,t.effective_sent_at) RETURNING to_jsonb(retention_ltp_test_audit.*) INTO result;
    IF p_operation='backdate' THEN RAISE LOG 'LTP backdate used sequence=% operator=%',s.id,actor; END IF;
    RETURN result;
  ELSIF p_operation='due' THEN
    IF jsonb_array_length(p_payload->'candidate_ids') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Select 1-50 step-1 candidates'; END IF;
    IF (SELECT count(*) FROM public.retention_ltp_test_controls
      WHERE club_id=p_club_id AND candidate_id IN (SELECT value::uuid FROM jsonb_array_elements_text(p_payload->'candidate_ids')))
      IS DISTINCT FROM jsonb_array_length(p_payload->'candidate_ids')::bigint THEN
      RAISE EXCEPTION 'Every selected candidate must be a backdated test step 1';
    END IF;
    -- Verify every selected source, including replied/exited sequences. Those
    -- states return no draft rather than being reactivated by test controls.
    FOR c IN SELECT * FROM public.retention_candidates WHERE club_id=p_club_id
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(p_payload->'candidate_ids')) LOOP
      PERFORM public.retention_ltp_test_effective_time(c.sequence_id);
    END LOOP;
    SELECT COALESCE(jsonb_agg(to_jsonb(source_candidate)||jsonb_build_object(
      'step1_sent_at',root.step1_sent_at,'step1_delivery_kind','test','test_mode',true
    )),'[]'::jsonb) INTO result
    FROM public.retention_ltp_test_controls control JOIN public.retention_sequences root ON root.id=control.sequence_id
    JOIN public.retention_candidates source_candidate ON source_candidate.id=control.candidate_id
    JOIN public.retention_playbooks playbook ON playbook.key='ltp_followup' AND playbook.enabled
    WHERE control.club_id=p_club_id AND source_candidate.id IN (SELECT value::uuid FROM jsonb_array_elements_text(p_payload->'candidate_ids'))
      AND root.sequence_status='active'
      AND now()-control.effective_sent_at>=make_interval(days=>(playbook.ltp_sequence_config->>'step2_gap_days')::integer)
      AND NOT EXISTS(SELECT 1 FROM public.retention_candidates c2 WHERE c2.sequence_id=root.id AND c2.step=2);
    RETURN result;
  ELSIF p_operation='save' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'items') LOOP
      IF item->>'step' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'Test drafting supports step 2 only'; END IF;
      SELECT * INTO s FROM public.retention_sequences WHERE club_id=p_club_id AND player_id=(item->>'player_id')::uuid AND playbook_key='ltp_followup' FOR UPDATE;
      PERFORM public.retention_ltp_test_effective_time(s.id);
    END LOOP;
    RETURN public.retention_sequence_save_batch_test(p_club_id,p_payload->'items');
  ELSIF p_operation IN ('claim','record_send','exit_booked') THEN
    SELECT * INTO c FROM public.retention_candidates
      WHERE message_id=(p_payload->>'message_id')::uuid AND club_id=p_club_id AND step=2 FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Test step-2 candidate not found'; END IF;
    PERFORM public.retention_ltp_test_effective_time(c.sequence_id);
    SELECT * INTO t FROM public.retention_ltp_test_controls WHERE sequence_id=c.sequence_id;
    IF p_operation='exit_booked' THEN
      actor:=btrim(p_payload->>'actor');
      IF NOT t.simulated_booking OR actor IS NULL OR length(actor)<1 OR length(actor)>120 THEN
        RAISE EXCEPTION 'Simulated booking and actor are required';
      END IF;
      SELECT * INTO m FROM public.messages WHERE id=c.message_id FOR UPDATE;
      IF c.status IS DISTINCT FROM 'drafted' OR c.sequence_status IS DISTINCT FROM 'active'
        OR m.status IS DISTINCT FROM 'pending' OR m.approved_at IS NOT NULL
        OR m.scheduled_send_at IS NOT NULL OR m.sent_at IS NOT NULL OR m.dispatch_claimed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Only an unapproved unclaimed test draft can be checked';
      END IF;
      result:=public.retention_sequence_transition(p_club_id,c.player_id,'ltp_followup',
        'exited_booked','test_simulated_booking_at_dispatch','test-simulated-booking');
      INSERT INTO public.retention_ltp_test_audit(club_id,candidate_id,actor,action,original_sent_at,effective_sent_at)
        VALUES(p_club_id,c.id,actor,'dispatch_blocked',t.original_sent_at,t.effective_sent_at);
      RETURN result;
    END IF;
    IF t.simulated_booking THEN RAISE EXCEPTION 'Simulated booking blocks test dispatch'; END IF;
    IF p_operation='claim' THEN
      RETURN public.retention_sequence_claim_test(p_club_id,c.id,c.message_id,
        p_payload->>'expected_body',(p_payload->>'claimed_at')::timestamptz,
        p_payload->'expected_context',(p_payload->>'expected_updated_at')::timestamptz);
    END IF;
    IF p_payload->>'delivery_kind' IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'Only test delivery is allowed'; END IF;
    RETURN public.retention_sequence_record_send_test(p_club_id,c.message_id,'test');
  ELSE
    RAISE EXCEPTION 'Unsupported test operation';
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF p_operation='backdate' THEN
    RAISE LOG 'LTP backdate refused sequence=% operator=% sqlstate=%',audit_sequence,actor,SQLSTATE;
  END IF;
  RAISE;
END $$;
REVOKE ALL ON FUNCTION public.retention_ltp_test_effective_time(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.retention_ltp_test_rpc(uuid,text,jsonb,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retention_ltp_test_rpc(uuid,text,jsonb,boolean) TO service_role;
COMMIT;

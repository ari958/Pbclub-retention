-- Apply MANUALLY in the existing Supabase SQL Editor.
-- No approvals, sends, settings changes, or reset calls are made by installation.
BEGIN;
ALTER TABLE public.retention_ltp_test_audit ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Fix the draft writers, not the shared timestamp default used by inbound SMS.
DO $migration$
DECLARE fn record; source text; amended text;
BEGIN
  FOR fn IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'retention_create_candidate','retention_sequence_save_batch','retention_sequence_save_batch_test'
    ) LOOP
    source:=pg_get_functiondef(fn.oid);
    amended:=replace(source,'INSERT INTO public.messages(player_id,body,direction,sent_by,status)',
      'INSERT INTO public.messages(player_id,body,direction,sent_by,status,sent_at)');
    amended:=replace(amended,'''outbound'',''agent'',''pending'')',
      '''outbound'',''agent'',''pending'',NULL)');
    IF strpos(amended,'INSERT INTO public.messages(player_id,body,direction,sent_by,status,sent_at)')=0
      OR strpos(amended,'''outbound'',''agent'',''pending'',NULL)')=0 THEN
      RAISE EXCEPTION 'Unexpected draft writer; inspect before installation';
    END IF;
    IF amended<>source THEN EXECUTE amended; END IF;
  END LOOP;
END $migration$;

CREATE OR REPLACE FUNCTION public.retention_ltp_test_reset(
  p_club_id uuid,p_candidate_id uuid,p_actor text,p_override_enabled boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.retention_candidates%ROWTYPE; s public.retention_sequences%ROWTYPE;
  m public.messages%ROWTYPE; t public.retention_ltp_test_controls%ROWTYPE; prior jsonb;
BEGIN
  IF p_override_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMS_TEST_OVERRIDE_TO is required' USING ERRCODE='42501';
  END IF;
  IF p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Actor is required'; END IF;
  SELECT * INTO c FROM public.retention_candidates WHERE id=p_candidate_id AND club_id=p_club_id;
  IF NOT FOUND OR c.playbook_key IS DISTINCT FROM 'ltp_followup' OR c.step NOT IN (1,2) THEN
    RAISE EXCEPTION 'LTP step candidate not found';
  END IF;
  SELECT * INTO s FROM public.retention_sequences WHERE id=c.sequence_id AND club_id=p_club_id FOR UPDATE;
  IF NOT FOUND OR s.sequence_status NOT IN ('active','completed') THEN
    RAISE EXCEPTION 'A genuine booking, opt-out, or reply exit must not be reactivated';
  END IF;
  SELECT * INTO c FROM public.retention_candidates WHERE id=p_candidate_id FOR UPDATE;
  SELECT * INTO m FROM public.messages WHERE id=c.message_id AND player_id=c.player_id FOR UPDATE;
  IF NOT FOUND OR c.status IS DISTINCT FROM 'sent' OR m.status IS DISTINCT FROM 'sent'
    OR m.simulated IS DISTINCT FROM true OR m.retention_delivery_kind IS DISTINCT FROM 'simulated'
    OR m.sent_at IS NULL OR m.delivered_at IS NOT NULL OR m.delivery_status IS NOT NULL
    OR (m.twilio_message_sid IS NOT NULL AND m.twilio_message_sid<>'SIMULATED')
    OR EXISTS(SELECT 1 FROM public.contact_ledger WHERE message_id=m.id) THEN
    RAISE EXCEPTION 'Only never-delivered simulated messages without a Twilio SID may be reset';
  END IF;
  -- SIMULATED is the legacy placeholder, never a real provider SID.
  IF c.step=1 AND EXISTS(SELECT 1 FROM public.retention_candidates WHERE sequence_id=s.id AND step=2) THEN
    RAISE EXCEPTION 'Cannot reset step 1 after step 2 exists';
  END IF;
  IF (c.step=1 AND s.step1_message_id IS DISTINCT FROM m.id)
    OR (c.step=2 AND s.step2_message_id IS DISTINCT FROM m.id) THEN
    RAISE EXCEPTION 'Sequence message identity mismatch';
  END IF;
  SELECT * INTO t FROM public.retention_ltp_test_controls WHERE sequence_id=s.id;
  IF t.simulated_booking IS TRUE THEN RAISE EXCEPTION 'Simulated booking must not be bypassed'; END IF;
  prior:=jsonb_build_object('message',to_jsonb(m),'candidate_status',c.status,'sequence',to_jsonb(s));
  INSERT INTO public.retention_ltp_test_audit(club_id,candidate_id,actor,action,original_sent_at,effective_sent_at,details)
    VALUES(p_club_id,c.id,btrim(p_actor),'reset_simulated',
      COALESCE(t.original_sent_at,m.sent_at),COALESCE(t.effective_sent_at,m.sent_at),prior);
  UPDATE public.messages SET status='pending',approved_at=NULL,approved_by=NULL,approved_body=NULL,
    scheduled_send_at=NULL,sent_at=NULL,dispatch_claimed_at=NULL,dispatch_token=NULL,
    twilio_message_sid=NULL,simulated=false,retention_delivery_kind=NULL,error_message=NULL
    WHERE id=m.id;
  DELETE FROM public.retention_capacity_reservations WHERE candidate_id=c.id;
  UPDATE public.retention_sequences SET sequence_status='active',exited_at=NULL,exit_reason=NULL,booked_event_id=NULL,
    step1_sent_at=CASE WHEN c.step=1 THEN NULL ELSE step1_sent_at END,
    step1_delivery_kind=CASE WHEN c.step=1 THEN NULL ELSE step1_delivery_kind END,
    step2_sent_at=CASE WHEN c.step=2 THEN NULL ELSE step2_sent_at END,updated_at=now()
    WHERE id=s.id;
  UPDATE public.retention_candidates SET sequence_status='active',exited_at=NULL,exit_reason=NULL,booked_event_id=NULL,
    updated_at=now() WHERE sequence_id=s.id;
  -- Rebuild must finish before another operator can approve these old facts.
  UPDATE public.retention_candidates SET status='needs_context',
    context=context||jsonb_build_object('reason','test_reset_requires_rebuild',
      'errors',jsonb_build_array('Test simulation reset; rebuild fresh session facts before approval')),
    updated_at=now() WHERE id=c.id RETURNING * INTO c;
  RETURN to_jsonb(c);
END $$;
REVOKE ALL ON FUNCTION public.retention_ltp_test_reset(uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retention_ltp_test_reset(uuid,uuid,text,boolean) TO service_role;
COMMIT;

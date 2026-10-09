-- Applied manually in the Supabase SQL Editor on 2026-10-08.
-- FUNCTION-ONLY installer for the updated 015 test-clock guard.
-- Do not rerun migration 015 (or 022/023). No data or sending-setting changes.
BEGIN;
CREATE OR REPLACE FUNCTION public.retention_assert_backdate_destinations(
  p_club_id uuid,p_payload jsonb,p_override_enabled boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.retention_sequences%ROWTYPE; resolved_sequence_id uuid;
  actor text; override_digits text; ids uuid[]; count_sent integer;
BEGIN
  actor:=btrim(p_payload->>'actor');
  SELECT c.sequence_id INTO resolved_sequence_id FROM public.retention_candidates c
    WHERE c.id=(p_payload->>'candidate_id')::uuid AND c.club_id=p_club_id;
  RAISE LOG 'LTP backdate attempt sequence=% operator=%',resolved_sequence_id,actor;
  IF p_override_enabled IS DISTINCT FROM true OR actor IS NULL OR resolved_sequence_id IS NULL THEN
    RAISE EXCEPTION 'Override, sequence, and operator required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO s FROM public.retention_sequences WHERE id=resolved_sequence_id AND club_id=p_club_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sequence missing' USING ERRCODE='42501'; END IF;
  override_digits:=regexp_replace(COALESCE(p_payload->>'override_to',''),'[^0-9]','','g');
  IF length(override_digits)=10 THEN override_digits:='1'||override_digits; END IF;
  IF override_digits !~ '^[0-9]{11,15}$'
    OR p_payload->>'destination_evidence_source' IS DISTINCT FROM 'twilio_stored'
    OR jsonb_typeof(p_payload->'verified_destinations') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Stored override destination evidence required' USING ERRCODE='42501';
  END IF;
  SELECT array_agg(DISTINCT message_id) INTO ids FROM (
    SELECT message_id FROM public.retention_candidates WHERE sequence_id=s.id AND club_id=p_club_id
    UNION SELECT s.step1_message_id UNION SELECT s.step2_message_id
  ) links WHERE message_id IS NOT NULL;
  IF (s.step1_sent_at IS NOT NULL AND s.step1_message_id IS NULL)
    OR (s.step2_sent_at IS NOT NULL AND s.step2_message_id IS NULL)
    OR EXISTS(SELECT 1 FROM unnest(ids) AS link(message_id)
      WHERE NOT EXISTS(SELECT 1 FROM public.messages WHERE messages.id=link.message_id)) THEN
    RAISE EXCEPTION 'Linked evidence missing' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.messages WHERE id=ANY(ids) FOR UPDATE;
  SELECT count(*) INTO count_sent FROM public.messages m WHERE m.id=ANY(ids)
    AND (m.status='sent' OR m.id=s.step1_message_id OR (s.step2_sent_at IS NOT NULL AND m.id=s.step2_message_id));
  IF count_sent=0 OR count_sent<>jsonb_array_length(p_payload->'verified_destinations')
    OR EXISTS(SELECT 1 FROM public.messages m WHERE m.id=ANY(ids)
      AND (m.status='sent' OR m.id=s.step1_message_id OR (s.step2_sent_at IS NOT NULL AND m.id=s.step2_message_id))
      AND (m.status IS DISTINCT FROM 'sent' OR m.sent_at IS NULL OR m.twilio_message_sid IS NULL
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'verified_destinations') d
          WHERE d->>'message_id'=m.id::text AND d->>'twilio_message_sid'=m.twilio_message_sid
            AND regexp_replace(COALESCE(d->>'to',''),'[^0-9]','','g')=override_digits))) THEN
    RAISE EXCEPTION 'Every sent message must match stored override destination' USING ERRCODE='42501';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'LTP backdate refused sequence=% operator=% sqlstate=%',resolved_sequence_id,actor,SQLSTATE;
  RAISE;
END $$;
REVOKE ALL ON FUNCTION public.retention_assert_backdate_destinations(uuid,jsonb,boolean)
  FROM PUBLIC,anon,authenticated,service_role;

DO $install$
DECLARE source text; amended text;
BEGIN
  source:=pg_get_functiondef('public.retention_ltp_test_rpc(uuid,text,jsonb,boolean)'::regprocedure);
  IF position('Stored override destinations are required' IN source)>0
    OR position('retention_assert_backdate_destinations' IN source)>0 THEN RETURN; END IF;
  amended:=replace(source,'BEGIN'||chr(10)||'  IF p_override_enabled',
    'BEGIN'||chr(10)||'  IF p_operation=''backdate'' THEN PERFORM public.retention_assert_backdate_destinations(p_club_id,p_payload,p_override_enabled); END IF;'||chr(10)||'  IF p_override_enabled');
  amended:=replace(amended,
    'VALUES(p_club_id,c.id,actor,p_operation,t.original_sent_at,t.effective_sent_at) RETURNING to_jsonb(retention_ltp_test_audit.*) INTO result;',
    'VALUES(p_club_id,c.id,actor,p_operation,t.original_sent_at,t.effective_sent_at) RETURNING to_jsonb(retention_ltp_test_audit.*) INTO result;'||chr(10)||
    '    IF p_operation=''backdate'' THEN RAISE LOG ''LTP backdate used sequence=% operator=%'',s.id,actor; END IF;');
  -- Server LOG survives transaction rollback, unlike an audit-table INSERT.
  amended:=replace(amended,'END '||'$function$',
    'EXCEPTION WHEN OTHERS THEN'||chr(10)||
    '  IF p_operation=''backdate'' THEN RAISE LOG ''LTP backdate refused sequence=% operator=% sqlstate=%'',c.sequence_id,p_payload->>''actor'',SQLSTATE; END IF;'||chr(10)||
    '  RAISE;'||chr(10)||'END '||'$function$');
  IF amended=source OR position('retention_assert_backdate_destinations' IN amended)=0
    OR position('LTP backdate used' IN amended)=0 OR position('EXCEPTION WHEN OTHERS' IN amended)=0 THEN
    RAISE EXCEPTION 'Unexpected installed test RPC; guard not installed';
  END IF;
  EXECUTE amended;
END $install$;
REVOKE ALL ON FUNCTION public.retention_ltp_test_rpc(uuid,text,jsonb,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retention_ltp_test_rpc(uuid,text,jsonb,boolean) TO service_role;
COMMIT;

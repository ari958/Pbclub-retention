-- Apply manually in the EXISTING Supabase project's SQL Editor.
-- This adds guarded context retry; it does not loosen drafted-only regeneration,
-- change any stored candidate, approve anything, or change sending settings.
BEGIN;

CREATE OR REPLACE FUNCTION public.retention_retry_context(
  p_id uuid,
  p_club_id uuid,
  p_expected_body text,
  p_expected_context jsonb,
  p_expected_updated_at timestamptz,
  p_new_body text,
  p_new_context jsonb,
  p_new_status text,
  p_error text DEFAULT NULL,
  p_expected_message_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  c retention_candidates%ROWTYPE;
  m messages%ROWTYPE;
  msg_id uuid;
BEGIN
  SELECT * INTO c FROM retention_candidates
    WHERE id=p_id AND club_id=p_club_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Candidate not found'; END IF;
  IF c.status IS DISTINCT FROM 'needs_context'
     OR COALESCE(c.context->>'reason','') NOT IN ('context_lookup_failed','no_next_program') THEN
    RAISE EXCEPTION 'Only eligible needs_context candidates can retry context';
  END IF;
  IF c.context IS DISTINCT FROM p_expected_context
     OR c.updated_at IS DISTINCT FROM p_expected_updated_at
     OR c.message_id IS DISTINCT FROM p_expected_message_id THEN
    RAISE EXCEPTION 'Candidate changed since context retry began';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM players WHERE id=c.player_id AND club_id=p_club_id) THEN
    RAISE EXCEPTION 'Player does not belong to club';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM retention_playbooks WHERE key=c.playbook_key AND enabled) THEN
    RAISE EXCEPTION 'Playbook is not enabled';
  END IF;

  IF c.message_id IS NOT NULL THEN
    SELECT * INTO m FROM messages WHERE id=c.message_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Candidate message not found'; END IF;
    IF m.player_id IS DISTINCT FROM c.player_id
       OR m.body IS DISTINCT FROM p_expected_body THEN
      RAISE EXCEPTION 'Candidate message changed since context retry began';
    END IF;
    IF m.status IS DISTINCT FROM 'pending'
       OR m.approved_at IS NOT NULL OR m.approved_by IS NOT NULL
       OR m.approved_body IS NOT NULL OR m.scheduled_send_at IS NOT NULL
       OR m.sent_at IS NOT NULL OR m.dispatch_claimed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Message is approved, sent, scheduled, processed, or claimed';
    END IF;
    msg_id := m.id;
  ELSIF p_expected_body IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected body for unlinked candidate';
  END IF;

  IF p_new_status IS NULL OR p_new_status NOT IN ('drafted','needs_context','manual_edit','skipped') THEN
    RAISE EXCEPTION 'Unsupported context retry status';
  END IF;
  IF p_new_context IS NULL OR jsonb_typeof(p_new_context)<>'object' THEN
    RAISE EXCEPTION 'Retried context must be a JSON object';
  END IF;
  IF p_new_status='drafted' THEN
    IF length(btrim(COALESCE(p_new_body,'')))=0 THEN RAISE EXCEPTION 'Draft body is required'; END IF;
    IF NULLIF(p_new_context->>'reason','') IS NOT NULL
       OR COALESCE(p_new_context->'errors','[]'::jsonb)<>'[]'::jsonb
       OR COALESCE(p_new_context->'validation_errors','[]'::jsonb)<>'[]'::jsonb THEN
      RAISE EXCEPTION 'Drafted retry must have no unresolved context or validation errors';
    END IF;
  ELSE
    IF length(btrim(COALESCE(p_new_body,'')))>0 THEN
      RAISE EXCEPTION 'Blocked retry cannot retain pending message text';
    END IF;
    IF length(btrim(COALESCE(p_new_context->>'reason','')))=0 THEN
      RAISE EXCEPTION 'Blocked retry context must include a reason';
    END IF;
  END IF;

  -- Keep existing message identity and approval evidence unchanged.
  -- Only a newly validated draft may construct a previously missing message.
  IF msg_id IS NOT NULL THEN
    UPDATE messages
      SET body=CASE WHEN p_new_status='drafted' THEN btrim(p_new_body) ELSE '' END,
          error_message=p_error
      WHERE id=msg_id;
  ELSIF p_new_status='drafted' THEN
    INSERT INTO messages(player_id,body,direction,sent_by,status,approved_at,approved_by,
      approved_body,scheduled_send_at,sent_at)
      VALUES(c.player_id,btrim(p_new_body),'outbound','agent','pending',NULL,NULL,NULL,NULL,NULL)
      RETURNING id INTO msg_id;
  END IF;
  UPDATE retention_candidates
    SET context=p_new_context,status=p_new_status,message_id=msg_id,updated_at=now()
    WHERE id=c.id;
  SELECT * INTO c FROM retention_candidates WHERE id=c.id;
  RETURN to_jsonb(c);
END $$;

CREATE OR REPLACE FUNCTION public.retention_context_retry_ready()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT public.retention_schema_ready()
    AND to_regprocedure('public.retention_retry_context(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text,uuid)') IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.retention_retry_context(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text,uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_context_retry_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retention_retry_context(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_context_retry_ready() TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Both checks must return true before running a retry batch.
SELECT public.retention_schema_ready() AS retention_schema_ready;
SELECT public.retention_context_retry_ready() AS retention_context_retry_ready;
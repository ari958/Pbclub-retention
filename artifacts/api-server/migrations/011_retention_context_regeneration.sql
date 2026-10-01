-- Additive LTP context/text safety, blocked statuses, and atomic draft regeneration.
-- Run manually in the EXISTING Supabase project's SQL Editor. Do not apply through
-- Replit's local DATABASE_URL or run automatically from application code.
BEGIN;

ALTER TABLE public.retention_candidates
  DROP CONSTRAINT IF EXISTS retention_candidates_status_check;
ALTER TABLE public.retention_candidates
  ADD CONSTRAINT retention_candidates_status_check
  CHECK (status IN ('drafted','approved','skipped','sent','needs_context','manual_edit'));

-- New rows with missing context or invalid text have no linked pending message.
-- A pending message is created only for a validated drafted candidate.
CREATE OR REPLACE FUNCTION public.retention_create_candidate(
  p_club_id uuid,
  p_player_id uuid,
  p_playbook_key text,
  p_trigger_event_id text,
  p_context jsonb,
  p_status text,
  p_body text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate_id uuid; msg_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM players WHERE id=p_player_id AND club_id=p_club_id) THEN
    RAISE EXCEPTION 'Player does not belong to club';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM retention_playbooks WHERE key=p_playbook_key AND enabled) THEN
    RAISE EXCEPTION 'Playbook is not enabled';
  END IF;
  IF p_status NOT IN ('drafted','needs_context','manual_edit','skipped') THEN
    RAISE EXCEPTION 'Unsupported retention candidate status';
  END IF;
  IF p_context IS NULL OR jsonb_typeof(p_context)<>'object' THEN
    RAISE EXCEPTION 'Candidate context must be a JSON object';
  END IF;
  IF p_status='drafted' AND length(btrim(COALESCE(p_body,'')))=0 THEN
    RAISE EXCEPTION 'Draft body is required';
  END IF;
  IF p_status<>'drafted' AND length(btrim(COALESCE(p_body,'')))>0 THEN
    RAISE EXCEPTION 'Blocked candidates cannot have pending message text';
  END IF;
  IF p_status<>'drafted' AND length(btrim(COALESCE(p_context->>'reason','')))=0 THEN
    RAISE EXCEPTION 'Blocked candidate context must include a reason';
  END IF;
  INSERT INTO retention_candidates(club_id,player_id,playbook_key,trigger_event_id,context,status)
    VALUES(p_club_id,p_player_id,p_playbook_key,p_trigger_event_id,p_context,p_status)
    ON CONFLICT(player_id,playbook_key) DO NOTHING RETURNING id INTO candidate_id;
  IF candidate_id IS NULL THEN RETURN NULL; END IF;
  IF p_status='drafted' THEN
    INSERT INTO messages(player_id,body,direction,sent_by,status,approved_at,approved_by,
      approved_body,scheduled_send_at,sent_at)
      VALUES(p_player_id,btrim(p_body),'outbound','agent','pending',NULL,NULL,NULL,NULL,NULL)
      RETURNING id INTO msg_id;
    UPDATE retention_candidates SET message_id=msg_id WHERE id=candidate_id;
  END IF;
  RETURN candidate_id;
END $$;

-- Lock candidate then its message and compare the exact reviewed snapshot before
-- changing either. Message/candidate identifiers are never replaced by regen.
CREATE OR REPLACE FUNCTION public.retention_regenerate_draft(
  p_id uuid,
  p_club_id uuid,
  p_expected_body text,
  p_expected_context jsonb,
  p_expected_updated_at timestamptz,
  p_new_body text,
  p_new_context jsonb,
  p_new_status text,
  p_error text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c retention_candidates%ROWTYPE; m messages%ROWTYPE;
BEGIN
  SELECT * INTO c FROM retention_candidates
    WHERE id=p_id AND club_id=p_club_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Candidate not found'; END IF;
  IF c.status<>'drafted' THEN RAISE EXCEPTION 'Only drafted candidates can be regenerated'; END IF;
  IF c.context IS DISTINCT FROM p_expected_context
     OR c.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Candidate changed since regeneration began';
  END IF;
  IF c.message_id IS NULL THEN RAISE EXCEPTION 'Draft message is missing'; END IF;
  SELECT * INTO m FROM messages WHERE id=c.message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Draft message is missing'; END IF;
  IF m.body IS DISTINCT FROM p_expected_body THEN
    RAISE EXCEPTION 'Draft body changed since regeneration began';
  END IF;
  IF m.status<>'pending' OR m.approved_at IS NOT NULL OR m.approved_by IS NOT NULL
     OR m.approved_body IS NOT NULL OR m.dispatch_claimed_at IS NOT NULL
     OR m.scheduled_send_at IS NOT NULL OR m.sent_at IS NOT NULL
     OR c.status IN ('approved','sent','skipped') THEN
    RAISE EXCEPTION 'Draft is approved, sent, scheduled, processed, or claimed';
  END IF;
  IF p_new_status NOT IN ('drafted','needs_context','manual_edit','skipped') THEN
    RAISE EXCEPTION 'Unsupported regeneration status';
  END IF;
  IF p_new_context IS NULL OR jsonb_typeof(p_new_context)<>'object' THEN
    RAISE EXCEPTION 'Regenerated context must be a JSON object';
  END IF;
  IF p_new_status='drafted' AND length(btrim(COALESCE(p_new_body,'')))=0 THEN
    RAISE EXCEPTION 'Regenerated draft body is required';
  END IF;
  IF p_new_status<>'drafted' AND length(btrim(COALESCE(p_new_body,'')))>0 THEN
    RAISE EXCEPTION 'Blocked regeneration cannot retain pending message text';
  END IF;
  IF p_new_status<>'drafted' AND length(btrim(COALESCE(p_new_context->>'reason','')))=0 THEN
    RAISE EXCEPTION 'Blocked regeneration context must include a reason';
  END IF;

  UPDATE messages SET body=CASE WHEN p_new_status='drafted' THEN btrim(p_new_body) ELSE '' END,
    approved_at=NULL,approved_by=NULL,approved_body=NULL,scheduled_send_at=NULL,
    error_message=p_error
    WHERE id=m.id;
  UPDATE retention_candidates SET context=p_new_context,status=p_new_status,updated_at=now()
    WHERE id=c.id;
  SELECT * INTO c FROM retention_candidates WHERE id=c.id;
  RETURN to_jsonb(c);
END $$;

-- Explicit manual-edit escape hatch. Application validates all LTP text rules
-- first; this RPC only permits flagged rows and uses the same freshness guard.
CREATE OR REPLACE FUNCTION public.retention_manual_edit_candidate(
  p_id uuid,
  p_club_id uuid,
  p_body text,
  p_expected_body text,
  p_expected_context jsonb,
  p_expected_updated_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c retention_candidates%ROWTYPE; m messages%ROWTYPE; msg_id uuid; next_context jsonb;
BEGIN
  IF length(btrim(COALESCE(p_body,'')))=0 THEN RAISE EXCEPTION 'Body is required'; END IF;
  SELECT * INTO c FROM retention_candidates
    WHERE id=p_id AND club_id=p_club_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Candidate not found'; END IF;
  IF c.status NOT IN ('needs_context','manual_edit') THEN
    RAISE EXCEPTION 'Manual edit is only allowed for flagged candidates';
  END IF;
  IF c.context IS DISTINCT FROM p_expected_context
     OR c.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Candidate changed since manual edit began';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM players WHERE id=c.player_id AND club_id=p_club_id) THEN
    RAISE EXCEPTION 'Player does not belong to club';
  END IF;
  IF c.message_id IS NOT NULL THEN
    SELECT * INTO m FROM messages WHERE id=c.message_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Candidate message not found'; END IF;
    IF m.body IS DISTINCT FROM p_expected_body THEN RAISE EXCEPTION 'Candidate message changed since manual edit began'; END IF;
    IF m.status<>'pending' OR m.approved_at IS NOT NULL OR m.dispatch_claimed_at IS NOT NULL
       OR m.scheduled_send_at IS NOT NULL OR m.sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'Candidate message is approved, scheduled, processed, or claimed';
    END IF;
    msg_id := m.id;
    UPDATE messages SET body=btrim(p_body),approved_at=NULL,approved_by=NULL,
      approved_body=NULL,scheduled_send_at=NULL,error_message=NULL WHERE id=msg_id;
  ELSE
    IF p_expected_body IS NOT NULL THEN RAISE EXCEPTION 'Unexpected body for unlinked candidate'; END IF;
    INSERT INTO messages(player_id,body,direction,sent_by,status,approved_at,approved_by,
      approved_body,scheduled_send_at,sent_at)
      VALUES(c.player_id,btrim(p_body),'outbound','agent','pending',NULL,NULL,NULL,NULL,NULL)
      RETURNING id INTO msg_id;
  END IF;
  next_context := (c.context - 'generated_preview') || jsonb_build_object(
    'reason',NULL,
    'errors','[]'::jsonb,
    'validation_errors','[]'::jsonb,
    'diagnostics',COALESCE(c.context->'diagnostics','{}'::jsonb) ||
      jsonb_build_object('manual_edit_resolved_at',now(),'previous_reason',c.context->'reason')
  );
  UPDATE retention_candidates SET status='drafted',message_id=msg_id,context=next_context,updated_at=now()
    WHERE id=c.id;
  SELECT * INTO c FROM retention_candidates WHERE id=c.id;
  RETURN to_jsonb(c);
END $$;

-- Keep existing mutations, but explicitly prohibit approve/edit from flagged
-- statuses and prevent any operation from clearing an existing approval/schedule.
CREATE OR REPLACE FUNCTION public.retention_update_candidate(
  p_id uuid, p_club_id uuid, p_action text,
  p_body text DEFAULT NULL, p_actor text DEFAULT NULL, p_scheduled_at timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c retention_candidates%ROWTYPE; m messages%ROWTYPE;
BEGIN
  SELECT * INTO c FROM retention_candidates WHERE id=p_id AND club_id=p_club_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Candidate not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM players WHERE id=c.player_id AND club_id=p_club_id) THEN
    RAISE EXCEPTION 'Player does not belong to club';
  END IF;
  IF c.message_id IS NOT NULL THEN
    SELECT * INTO m FROM messages WHERE id=c.message_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Candidate message not found'; END IF;
    IF m.status<>'pending' OR m.approved_at IS NOT NULL OR m.dispatch_claimed_at IS NOT NULL
       OR m.scheduled_send_at IS NOT NULL OR m.sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'Message is already approved, processed, scheduled, or claimed';
    END IF;
  ELSIF p_action IN ('approve','edit') THEN
    RAISE EXCEPTION 'Candidate message is missing';
  END IF;
  IF c.status IN ('approved','sent') THEN RAISE EXCEPTION 'Approved or sent candidates cannot be changed'; END IF;
  IF p_action='edit' THEN
    IF c.status<>'drafted' THEN RAISE EXCEPTION 'Only drafted candidates can be edited'; END IF;
    IF length(btrim(COALESCE(p_body,'')))=0 THEN RAISE EXCEPTION 'Body is required'; END IF;
    UPDATE messages SET body=btrim(p_body),approved_at=NULL,approved_by=NULL,
      approved_body=NULL,scheduled_send_at=NULL WHERE id=m.id;
    UPDATE retention_candidates SET status='drafted',updated_at=now() WHERE id=c.id;
  ELSIF p_action='approve' THEN
    IF c.status<>'drafted' THEN RAISE EXCEPTION 'Only drafted candidates can be approved'; END IF;
    IF length(btrim(COALESCE(p_actor,'')))=0 THEN RAISE EXCEPTION 'Approval actor is required'; END IF;
    IF p_body IS NULL OR m.body IS DISTINCT FROM p_body THEN
      RAISE EXCEPTION 'Draft changed since review. Refresh and review it again.';
    END IF;
    IF p_scheduled_at IS NULL OR p_scheduled_at<=now() THEN
      RAISE EXCEPTION 'A future send schedule is required';
    END IF;
    UPDATE messages SET approved_at=now(),approved_by=btrim(p_actor),
      approved_body=body || CASE WHEN COALESCE(signup_url,'')<>'' THEN E'\n'||signup_url ELSE '' END,
      scheduled_send_at=p_scheduled_at WHERE id=m.id;
    UPDATE retention_candidates SET status='approved',updated_at=now() WHERE id=c.id;
  ELSIF p_action='skip' THEN
    IF c.status='skipped' THEN RETURN to_jsonb(c); END IF;
    IF c.message_id IS NOT NULL THEN
      UPDATE messages SET status='skipped',approved_at=NULL,approved_by=NULL,approved_body=NULL,
        scheduled_send_at=NULL,error_message='Skipped by operator' WHERE id=m.id;
    END IF;
    UPDATE retention_candidates SET status='skipped',updated_at=now(),
      context=context || jsonb_build_object('reason','skipped_by_operator') WHERE id=c.id;
  ELSE
    RAISE EXCEPTION 'Unknown candidate action';
  END IF;
  SELECT * INTO c FROM retention_candidates WHERE id=c.id;
  RETURN to_jsonb(c);
END $$;

CREATE OR REPLACE FUNCTION public.retention_schema_ready()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT
    to_regprocedure('public.retention_create_candidate(uuid,uuid,text,text,jsonb,text,text)') IS NOT NULL
    AND to_regprocedure('public.retention_regenerate_draft(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text)') IS NOT NULL
    AND to_regprocedure('public.retention_manual_edit_candidate(uuid,uuid,text,text,jsonb,timestamp with time zone)') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid='public.retention_candidates'::regclass
        AND conname='retention_candidates_status_check'
        AND pg_get_constraintdef(oid) LIKE '%needs_context%'
        AND pg_get_constraintdef(oid) LIKE '%manual_edit%'
    )
$$;

REVOKE ALL ON FUNCTION public.retention_create_candidate(uuid,uuid,text,text,jsonb,text,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_regenerate_draft(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_manual_edit_candidate(uuid,uuid,text,text,jsonb,timestamptz)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_schema_ready() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_update_candidate(uuid,uuid,text,text,text,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retention_create_candidate(uuid,uuid,text,text,jsonb,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_regenerate_draft(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_manual_edit_candidate(uuid,uuid,text,text,jsonb,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_schema_ready() TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_update_candidate(uuid,uuid,text,text,text,timestamptz) TO service_role;

COMMIT;

-- Read-only operator verification after manual application:
SELECT public.retention_schema_ready() AS retention_schema_ready;
SELECT status,count(*) FROM public.retention_candidates GROUP BY status ORDER BY status;
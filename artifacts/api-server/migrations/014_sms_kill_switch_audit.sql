-- Apply to the existing Supabase database. No backfill, approvals, sends,
-- message updates, or sending-setting changes are performed by this migration.
BEGIN;

CREATE TABLE IF NOT EXISTS public.sms_kill_switch_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor text NOT NULL CHECK (length(trim(actor)) BETWEEN 1 AND 120),
  actor_identity_type text NOT NULL CHECK (actor_identity_type IN ('operator_label', 'unidentified')),
  old_value boolean,
  new_value boolean NOT NULL,
  request_id text
);
CREATE INDEX IF NOT EXISTS sms_kill_switch_audit_club_time
  ON public.sms_kill_switch_audit (club_id, changed_at DESC);
ALTER TABLE public.sms_kill_switch_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_kill_switch_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.sms_kill_switch_audit TO service_role;

CREATE OR REPLACE FUNCTION public.retention_set_kill_switch(
  p_club_id uuid, p_enabled boolean, p_actor text, p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  previous boolean;
  audit_record public.sms_kill_switch_audit;
  actor_label text;
BEGIN
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'enabled must be a boolean'; END IF;
  actor_label := COALESCE(NULLIF(trim(p_actor), ''), 'unidentified operator');
  IF length(actor_label) > 120 THEN RAISE EXCEPTION 'actor is too long'; END IF;
  SELECT sms_kill_switch INTO previous FROM public.clubs WHERE id=p_club_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Club not found'; END IF;

  -- The label is not authenticated identity: this dashboard has no sign-in.
  INSERT INTO public.sms_kill_switch_audit
    (club_id, actor, actor_identity_type, old_value, new_value, request_id)
  VALUES
    (p_club_id, actor_label,
     CASE WHEN NULLIF(trim(p_actor), '') IS NULL THEN 'unidentified' ELSE 'operator_label' END,
     previous, p_enabled, p_request_id)
  RETURNING * INTO audit_record;
  UPDATE public.clubs SET sms_kill_switch=p_enabled WHERE id=p_club_id;
  RETURN jsonb_build_object(
    'enabled', p_enabled, 'old_value', previous,
    'changed_at', audit_record.changed_at, 'audit_id', audit_record.id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.retention_set_kill_switch(uuid,boolean,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retention_set_kill_switch(uuid,boolean,text,text) TO service_role;

COMMIT;
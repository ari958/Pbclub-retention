-- Apply manually in the existing Supabase SQL Editor before production.
-- No approval, dispatch, live setting, player, or anon SELECT changes.
BEGIN;
CREATE TABLE IF NOT EXISTS public.operator_job_locks (
  name text PRIMARY KEY,
  owner uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.operator_job_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operator_job_locks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.operator_job_locks TO service_role;

CREATE OR REPLACE FUNCTION public.operator_acquire_job_lock(p_name text,p_owner uuid,p_ttl_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE got text;
BEGIN
  IF p_ttl_seconds < 30 OR p_ttl_seconds > 300 THEN RAISE EXCEPTION 'Invalid lease TTL'; END IF;
  INSERT INTO public.operator_job_locks(name,owner,expires_at)
  VALUES(p_name,p_owner,clock_timestamp()+make_interval(secs=>p_ttl_seconds))
  ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
  WHERE operator_job_locks.expires_at < clock_timestamp()
  RETURNING name INTO got;
  RETURN got IS NOT NULL;
END $$;
CREATE OR REPLACE FUNCTION public.operator_renew_job_lock(p_name text,p_owner uuid,p_ttl_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE got text;
BEGIN
  IF p_ttl_seconds < 30 OR p_ttl_seconds > 300 THEN RAISE EXCEPTION 'Invalid lease TTL'; END IF;
  UPDATE public.operator_job_locks SET expires_at=clock_timestamp()+make_interval(secs=>p_ttl_seconds)
  WHERE name=p_name AND owner=p_owner AND expires_at>clock_timestamp() RETURNING name INTO got;
  RETURN got IS NOT NULL;
END $$;
CREATE OR REPLACE FUNCTION public.operator_release_job_lock(p_name text,p_owner uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE got text;
BEGIN
  DELETE FROM public.operator_job_locks WHERE name=p_name AND owner=p_owner RETURNING name INTO got;
  RETURN got IS NOT NULL;
END $$;
CREATE TABLE IF NOT EXISTS public.operator_runtime (
  name text PRIMARY KEY,
  updated_at timestamptz NOT NULL DEFAULT now(),
  result text NOT NULL
);
ALTER TABLE public.operator_runtime ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operator_runtime FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.operator_runtime TO service_role;
REVOKE ALL ON FUNCTION public.operator_acquire_job_lock(text,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.operator_renew_job_lock(text,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.operator_release_job_lock(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.operator_acquire_job_lock(text,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.operator_renew_job_lock(text,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.operator_release_job_lock(text,uuid) TO service_role;
COMMIT;

-- External Supabase: apply manually, then publish the matching code promptly.
-- This fences old worker binaries out of new job acquisitions. Existing workers
-- renewing a non-owner lease fail-stop. Job/SMS processing pauses until an
-- upgraded process owns background-worker. No player/message/approval writes.
BEGIN;
CREATE TABLE IF NOT EXISTS public.operator_worker_instances (
  instance_id uuid PRIMARY KEY, pid integer NOT NULL, host text NOT NULL,
  started_at timestamptz NOT NULL, environment text NOT NULL,
  run_background_jobs text NOT NULL, state text NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.operator_worker_runs (
  id uuid PRIMARY KEY, job text NOT NULL, holder jsonb NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz,
  status text NOT NULL CHECK(status IN ('running','done','error'))
);
CREATE INDEX IF NOT EXISTS operator_worker_runs_job_time_idx
  ON public.operator_worker_runs(job,started_at);
CREATE TABLE IF NOT EXISTS public.operator_alert_incidents (
  condition_key text PRIMARY KEY, incident_id uuid NOT NULL DEFAULT gen_random_uuid(),
  active boolean NOT NULL DEFAULT false, opened_at timestamptz, closed_at timestamptz,
  text text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS public.operator_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), incident_id uuid NOT NULL,
  condition_key text NOT NULL, phase text NOT NULL CHECK(phase IN ('alert','resolved')),
  text text NOT NULL, holder jsonb NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
  status text NOT NULL DEFAULT 'claimed' CHECK(status IN ('claimed','sent','unknown')),
  provider_sid text, error text, UNIQUE(incident_id,phase)
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['operator_worker_instances','operator_worker_runs',
    'operator_alert_incidents','operator_alert_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
  END LOOP;
END $$;

-- Preserve the last observed legacy pause state without re-notifying it on
-- upgrade. Existing alert records and kill-switch audit history are untouched.
INSERT INTO public.operator_alert_incidents(condition_key,active,opened_at,text)
SELECT 'kill_switch:'||c.id,true,r.updated_at,'SMS kill switch changed: paused.'
FROM public.clubs c JOIN public.operator_runtime r ON r.name='kill-switch'
WHERE c.slug='pb-club' AND c.sms_kill_switch=true AND r.result='paused'
ON CONFLICT(condition_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.operator_observe_alert(
  p_key text,p_active boolean,p_text text,p_holder jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i public.operator_alert_incidents%ROWTYPE;
  e public.operator_alert_events%ROWTYPE; active_now boolean:=p_active; text_now text:=p_text;
BEGIN
  IF length(p_key)>200 OR p_key IS NULL OR p_active IS NULL OR p_holder IS NULL THEN
    RAISE EXCEPTION 'Invalid alert observation';
  END IF;
  -- Verify the sender owns the sole live worker lease. Old/standby processes
  -- cannot submit alerts even when their configured RUN_BACKGROUND_JOBS is true.
  IF NOT EXISTS(SELECT 1 FROM public.operator_job_locks
    WHERE name='background-worker' AND owner=(p_holder->>'instance_id')::uuid
      AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Alert sender is not the active worker'; END IF;
  -- Re-read persisted state, not a stale API/watchdog snapshot.
  IF p_key LIKE 'kill_switch:%' THEN
    SELECT sms_kill_switch INTO STRICT active_now FROM public.clubs
      WHERE id=substring(p_key FROM length('kill_switch:')+1)::uuid FOR SHARE;
    IF active_now IS NULL THEN RAISE EXCEPTION 'Unverifiable kill switch'; END IF;
    text_now:='SMS kill switch changed: '||CASE WHEN active_now THEN 'paused.' ELSE 'resumed.' END;
  END IF;
  INSERT INTO public.operator_alert_incidents(condition_key) VALUES(p_key)
    ON CONFLICT(condition_key) DO NOTHING;
  SELECT * INTO STRICT i FROM public.operator_alert_incidents WHERE condition_key=p_key FOR UPDATE;
  IF i.active=active_now THEN RETURN NULL; END IF;
  IF active_now THEN
    UPDATE public.operator_alert_incidents SET active=true,incident_id=gen_random_uuid(),
      opened_at=clock_timestamp(),closed_at=NULL,text=COALESCE(text_now,'Operator condition detected')
      WHERE condition_key=p_key RETURNING * INTO i;
  ELSE
    UPDATE public.operator_alert_incidents SET active=false,closed_at=clock_timestamp()
      WHERE condition_key=p_key RETURNING * INTO i;
  END IF;
  -- Claim before calling Twilio: at most one provider submission per phase,
  -- even if it is accepted and the sender dies before persisting the SID.
  INSERT INTO public.operator_alert_events(incident_id,condition_key,phase,text,holder)
    VALUES(i.incident_id,p_key,CASE WHEN active_now THEN 'alert' ELSE 'resolved' END,
      CASE WHEN active_now THEN i.text ELSE COALESCE(text_now,'Condition cleared: '||i.text) END,p_holder)
    ON CONFLICT(incident_id,phase) DO NOTHING RETURNING * INTO e;
  IF e.id IS NULL THEN RETURN NULL; END IF;
  RETURN to_jsonb(e);
END $$;
REVOKE ALL ON FUNCTION public.operator_observe_alert(text,boolean,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.operator_observe_alert(text,boolean,text,jsonb) TO service_role;

-- Existing signatures are retained. All per-job leases must belong to the
-- current global owner, fencing old binaries that use anonymous per-job UUIDs.
CREATE OR REPLACE FUNCTION public.operator_acquire_job_lock(p_name text,p_owner uuid,p_ttl_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE got text;
BEGIN
  IF p_ttl_seconds<30 OR p_ttl_seconds>300 THEN RAISE EXCEPTION 'Invalid lease TTL'; END IF;
  IF p_name<>'background-worker' AND NOT EXISTS(SELECT 1 FROM public.operator_job_locks
    WHERE name='background-worker' AND owner=p_owner AND expires_at>clock_timestamp()) THEN RETURN false; END IF;
  INSERT INTO public.operator_job_locks(name,owner,expires_at)
    VALUES(p_name,p_owner,clock_timestamp()+make_interval(secs=>p_ttl_seconds))
  ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
    WHERE operator_job_locks.expires_at<clock_timestamp() RETURNING name INTO got;
  RETURN got IS NOT NULL;
END $$;
CREATE OR REPLACE FUNCTION public.operator_renew_job_lock(p_name text,p_owner uuid,p_ttl_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE got text;
BEGIN
  IF p_ttl_seconds<30 OR p_ttl_seconds>300 THEN RAISE EXCEPTION 'Invalid lease TTL'; END IF;
  IF p_name<>'background-worker' AND NOT EXISTS(SELECT 1 FROM public.operator_job_locks
    WHERE name='background-worker' AND owner=p_owner AND expires_at>clock_timestamp()) THEN RETURN false; END IF;
  UPDATE public.operator_job_locks SET expires_at=clock_timestamp()+make_interval(secs=>p_ttl_seconds)
    WHERE name=p_name AND owner=p_owner AND expires_at>clock_timestamp() RETURNING name INTO got;
  RETURN got IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION public.operator_acquire_job_lock(text,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.operator_renew_job_lock(text,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.operator_acquire_job_lock(text,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.operator_renew_job_lock(text,uuid,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

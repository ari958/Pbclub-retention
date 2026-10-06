-- Run only in an isolated PostgreSQL fixture after migration 017.
BEGIN;
DO $$
DECLARE a uuid := '00000000-0000-4000-8000-000000000001';
  b uuid := '00000000-0000-4000-8000-000000000002';
BEGIN
  IF NOT public.operator_acquire_job_lock('queue',a,120) THEN RAISE EXCEPTION 'first acquisition failed'; END IF;
  IF public.operator_acquire_job_lock('queue',b,120) THEN RAISE EXCEPTION 'overlap accepted'; END IF;
  IF public.operator_release_job_lock('queue',b) THEN RAISE EXCEPTION 'other owner released lock'; END IF;
  IF public.operator_renew_job_lock('queue',b,120) THEN RAISE EXCEPTION 'other owner renewed lock'; END IF;
  IF NOT public.operator_renew_job_lock('queue',a,120) THEN RAISE EXCEPTION 'owner renewal failed'; END IF;
  UPDATE public.operator_job_locks SET expires_at=now()-interval '1 second' WHERE name='queue';
  IF public.operator_renew_job_lock('queue',a,120) THEN RAISE EXCEPTION 'expired owner renewed'; END IF;
  IF NOT public.operator_acquire_job_lock('queue',b,120) THEN RAISE EXCEPTION 'expired lock not reclaimable'; END IF;
  IF public.operator_release_job_lock('queue',a) THEN RAISE EXCEPTION 'old owner released new lease'; END IF;
  IF NOT public.operator_release_job_lock('queue',b) THEN RAISE EXCEPTION 'new owner release failed'; END IF;
  IF has_function_privilege('anon','public.operator_acquire_job_lock(text,uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'anon can acquire'; END IF;
  IF has_table_privilege('anon','public.operator_runtime','SELECT') THEN RAISE EXCEPTION 'anon can read runtime'; END IF;
  IF NOT has_function_privilege('service_role','public.operator_acquire_job_lock(text,uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'service role cannot acquire'; END IF;
  RAISE NOTICE 'PASS: 12 database lease/security assertions';
END $$;
ROLLBACK;

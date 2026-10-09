-- External Supabase SQL Editor. PREPARED ONLY: do not apply automatically.
-- Observability only: no changes to candidates, approvals, playbooks, or sending.
BEGIN;
CREATE TABLE IF NOT EXISTS public.retention_generation_runs (
  id uuid PRIMARY KEY,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  playbook_key text,
  trigger text NOT NULL CHECK (trigger='nightly' OR trigger LIKE 'button:%'),
  operator text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  -- NULL means still running. Never label an unfinished run successful.
  status text CHECK (status IN ('success','partial','failed')),
  evaluated integer NOT NULL DEFAULT 0 CHECK(evaluated>=0),
  drafted integer NOT NULL DEFAULT 0 CHECK(drafted>=0),
  skipped integer NOT NULL DEFAULT 0 CHECK(skipped>=0),
  errors integer NOT NULL DEFAULT 0 CHECK(errors>=0),
  details jsonb NOT NULL DEFAULT '{"outcomes":[]}'::jsonb,
  CHECK ((finished_at IS NULL AND status IS NULL) OR (finished_at IS NOT NULL AND status IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS retention_generation_runs_club_time
  ON public.retention_generation_runs(club_id,started_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS public.nightly_sync_runs (
  id uuid PRIMARY KEY,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text CHECK(status IN ('success','partial','failed')),
  trigger text NOT NULL CHECK(trigger IN ('scheduled','manual')),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  CHECK ((finished_at IS NULL AND status IS NULL) OR (finished_at IS NOT NULL AND status IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS nightly_sync_runs_club_time
  ON public.nightly_sync_runs(club_id,started_at DESC,id DESC);
-- Private operational history, including player names. Access only through
-- the operator-authenticated, club-scoped API; never via anonymous Supabase.
ALTER TABLE public.retention_generation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nightly_sync_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.retention_generation_runs,public.nightly_sync_runs FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.retention_generation_runs,public.nightly_sync_runs TO service_role;
COMMIT;

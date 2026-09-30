-- Retention-only rollout. Run manually in the EXISTING Supabase project's SQL Editor.
-- Do not run against Replit's local DATABASE_URL; it is not the application DB.
-- The archival cutoff is immutable and intentionally predates new retention drafts.
-- Review the SELECT at the end before running if your environment is different.
BEGIN;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_body text,
  ADD COLUMN IF NOT EXISTS dispatch_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispatch_token uuid;
ALTER TABLE public.attendances ADD COLUMN IF NOT EXISTS coupon_code text;

-- Preserve existing status checks while admitting archived. Do not replace their
-- original accepted values with a guessed list from application source.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname, pg_get_expr(conbin, conrelid) AS expression
    FROM pg_constraint
    WHERE conrelid = 'public.messages'::regclass AND contype = 'c'
      AND pg_get_expr(conbin, conrelid) ~ '\mstatus\M'
      AND pg_get_expr(conbin, conrelid) NOT LIKE '%archived%'
  LOOP
    EXECUTE format('ALTER TABLE public.messages DROP CONSTRAINT %I', c.conname);
    EXECUTE format('ALTER TABLE public.messages ADD CONSTRAINT %I CHECK ((%s) OR status = %L)',
      c.conname, c.expression, 'archived');
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.messages'::regclass AND conname='messages_approval_evidence_check') THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_approval_evidence_check
      CHECK (approved_at IS NULL OR
        (approved_by IS NOT NULL AND length(btrim(approved_by)) > 0 AND approved_body IS NOT NULL));
  END IF;
END $$;

ALTER TABLE public.contact_ledger
  ADD COLUMN IF NOT EXISTS message_id uuid REFERENCES public.messages(id),
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS intended_player_id uuid REFERENCES public.players(id) ON DELETE SET NULL;
-- Redirected tests are not contacts with the original player.
ALTER TABLE public.contact_ledger ALTER COLUMN player_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contact_ledger_message_unique
  ON public.contact_ledger(message_id) WHERE message_id IS NOT NULL;
-- Legacy source checks only admitted promotion/experiment/manual. Retain those
-- rules while permitting the centralized dispatch service's additional sources.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname,pg_get_expr(conbin,conrelid) AS expression
    FROM pg_constraint WHERE conrelid='public.contact_ledger'::regclass AND contype='c'
      AND pg_get_expr(conbin,conrelid) ~ '\msource\M'
      AND pg_get_expr(conbin,conrelid) NOT LIKE '%retention%'
  LOOP
    EXECUTE format('ALTER TABLE public.contact_ledger DROP CONSTRAINT %I',c.conname);
    EXECUTE format('ALTER TABLE public.contact_ledger ADD CONSTRAINT %I CHECK ((%s) OR source IN (%L,%L,%L,%L,%L))',
      c.conname,c.expression,'retention','queue','bulk','feedback','system');
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.retention_playbooks (
  key text PRIMARY KEY,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  promo_code text,
  offer_text text,
  next_program_names text[] NOT NULL DEFAULT '{}',
  message_guidance text NOT NULL DEFAULT '',
  holdout_pct numeric NOT NULL DEFAULT 0 CHECK (holdout_pct BETWEEN 0 AND 100)
);
CREATE TABLE IF NOT EXISTS public.retention_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  player_id uuid NOT NULL REFERENCES public.players(id),
  playbook_key text NOT NULL REFERENCES public.retention_playbooks(key),
  trigger_event_id text NOT NULL,
  context jsonb NOT NULL,
  status text NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted','approved','skipped','sent')),
  message_id uuid REFERENCES public.messages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, playbook_key)
);
CREATE INDEX IF NOT EXISTS retention_candidates_club_status
  ON public.retention_candidates(club_id,status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS retention_candidates_message_unique
  ON public.retention_candidates(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_approved_due
  ON public.messages(scheduled_send_at)
  WHERE status='pending' AND approved_at IS NOT NULL AND dispatch_claimed_at IS NULL;

ALTER TABLE public.retention_playbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.retention_playbooks, public.retention_candidates FROM anon, authenticated;
GRANT ALL ON public.retention_playbooks, public.retention_candidates TO service_role;

INSERT INTO public.retention_playbooks
  (key,name,enabled,promo_code,offer_text,next_program_names,message_guidance,holdout_pct)
VALUES (
  'ltp_followup','Learn to Play follow-up',true,'LTPNEXT25','25% off your next program',
  ARRAY['Beginner 60&60 Clinic','30 & 30 Beginner Drills & Guided Play','Path to Advanced Beginner'],
  'Use only the supplied facts. Suggest the next suitable program. Mention classmates only as a count, never by name. If already booked, thank the player and say see you at the booked event, with no promo. Omit offers when coupon validation fails.',
  0
) ON CONFLICT (key) DO NOTHING;

-- Atomically create the candidate and its unapproved, unscheduled draft.
-- A repeated nightly run cannot create an orphan message or a duplicate candidate.
CREATE OR REPLACE FUNCTION public.retention_create_draft(
  p_club_id uuid, p_player_id uuid, p_playbook_key text,
  p_trigger_event_id text, p_context jsonb, p_body text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate_id uuid; msg_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM players WHERE id=p_player_id AND club_id=p_club_id) THEN
    RAISE EXCEPTION 'Player does not belong to club';
  END IF;
  IF length(btrim(COALESCE(p_body,'')))=0 THEN RAISE EXCEPTION 'Draft body is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM retention_playbooks WHERE key=p_playbook_key AND enabled) THEN
    RAISE EXCEPTION 'Playbook is not enabled';
  END IF;
  INSERT INTO retention_candidates(club_id,player_id,playbook_key,trigger_event_id,context)
    VALUES(p_club_id,p_player_id,p_playbook_key,p_trigger_event_id,p_context)
    ON CONFLICT(player_id,playbook_key) DO NOTHING RETURNING id INTO candidate_id;
  IF candidate_id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO messages(player_id,body,direction,sent_by,status,approved_at,approved_by,
    approved_body,scheduled_send_at,sent_at)
    VALUES(p_player_id,p_body,'outbound','agent','pending',NULL,NULL,NULL,NULL,NULL)
    RETURNING id INTO msg_id;
  UPDATE retention_candidates SET message_id=msg_id WHERE id=candidate_id;
  RETURN candidate_id;
END $$;

-- One transaction binds an explicit approval to exactly the reviewed SMS body.
-- Editing revokes approval and schedule; skipped/sent/claimed rows cannot be edited.
CREATE OR REPLACE FUNCTION public.retention_update_candidate(
  p_id uuid, p_club_id uuid, p_action text,
  p_body text DEFAULT NULL, p_actor text DEFAULT NULL, p_scheduled_at timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c retention_candidates%ROWTYPE; m messages%ROWTYPE;
BEGIN
  SELECT * INTO c FROM retention_candidates WHERE id=p_id AND club_id=p_club_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Candidate not found'; END IF;
  SELECT * INTO m FROM messages WHERE id=c.message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Candidate message not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM players WHERE id=c.player_id AND club_id=p_club_id) THEN
    RAISE EXCEPTION 'Player does not belong to club';
  END IF;
  IF m.status <> 'pending' OR m.dispatch_claimed_at IS NOT NULL OR c.status IN ('sent','skipped') THEN
    RAISE EXCEPTION 'Message is already processed or claimed for dispatch';
  END IF;
  IF p_action='edit' THEN
    IF length(btrim(COALESCE(p_body,'')))=0 THEN RAISE EXCEPTION 'Body is required'; END IF;
    UPDATE messages SET body=btrim(p_body), approved_at=NULL, approved_by=NULL,
      approved_body=NULL, scheduled_send_at=NULL WHERE id=m.id;
    UPDATE retention_candidates SET status='drafted',updated_at=now() WHERE id=c.id;
  ELSIF p_action='approve' THEN
    IF length(btrim(COALESCE(p_actor,'')))=0 THEN RAISE EXCEPTION 'Approval actor is required'; END IF;
    -- For approve, p_body is the operator's reviewed snapshot, NOT an edit.
    -- Reject a concurrent edit instead of silently approving unseen new text.
    IF p_body IS NULL OR m.body IS DISTINCT FROM p_body THEN
      RAISE EXCEPTION 'Draft changed since review. Refresh and review it again.';
    END IF;
    IF p_scheduled_at IS NULL OR p_scheduled_at<=now() THEN
      RAISE EXCEPTION 'A future send schedule is required';
    END IF;
    IF c.status='approved' AND m.approved_at IS NOT NULL THEN RETURN to_jsonb(c); END IF;
    IF c.status<>'drafted' THEN RAISE EXCEPTION 'Only drafts can be approved'; END IF;
    UPDATE messages SET approved_at=now(),approved_by=btrim(p_actor),
      approved_body=body || CASE WHEN COALESCE(signup_url,'')<>'' THEN E'\n'||signup_url ELSE '' END,
      scheduled_send_at=p_scheduled_at WHERE id=m.id;
    UPDATE retention_candidates SET status='approved',updated_at=now() WHERE id=c.id;
  ELSIF p_action='skip' THEN
    UPDATE messages SET status='skipped',approved_at=NULL,approved_by=NULL,approved_body=NULL,
      scheduled_send_at=NULL,error_message='Skipped by operator' WHERE id=m.id;
    UPDATE retention_candidates SET status='skipped',updated_at=now() WHERE id=c.id;
  ELSE
    RAISE EXCEPTION 'Unknown candidate action';
  END IF;
  SELECT * INTO c FROM retention_candidates WHERE id=c.id;
  RETURN to_jsonb(c);
END $$;

REVOKE ALL ON FUNCTION public.retention_create_draft(uuid,uuid,text,text,jsonb,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retention_update_candidate(uuid,uuid,text,text,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retention_create_draft(uuid,uuid,text,text,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_update_candidate(uuid,uuid,text,text,text,timestamptz) TO service_role;

-- The fixed cutoff prevents reruns from archiving retention drafts created later.
-- Approved rows are additionally excluded. No historic sent rows or attendance
-- records are modified. This is parking, never deleting.
UPDATE public.messages
SET status='archived', scheduled_send_at=NULL,
  error_message='Parked legacy pending message during retention-only rollout'
WHERE status='pending' AND approved_at IS NULL
  AND created_at < TIMESTAMPTZ '2026-09-30T22:09:46Z';

COMMIT;

-- Verification (read-only):
SELECT status,count(*) FROM public.messages GROUP BY status ORDER BY status;
SELECT key,promo_code,next_program_names,holdout_pct FROM public.retention_playbooks;
SELECT count(*) AS still_unapproved_scheduled
FROM public.messages WHERE status='pending' AND approved_at IS NULL AND scheduled_send_at IS NOT NULL;
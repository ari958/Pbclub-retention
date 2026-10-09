-- External Supabase SQL Editor; pending manual installation.
-- No sends, approvals, playbook changes, or consent-flag changes.
-- Existing START handling in 022 already clears opt-out flags and logs the
-- matched inbound receipt/message. Do not reinstall or change that function.
BEGIN;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
ALTER TABLE public.sms_optout_events ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

-- Bridge existing explicit markers, and protect designation from PodPlay
-- upserts/START/STOP. This is independent of consent and opt-out state.
CREATE OR REPLACE FUNCTION public.preserve_test_player_designation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  NEW.is_test:=COALESCE(NEW.is_test,false) OR strpos(COALESCE(NEW.notes,''),'[TEST_PLAYER]')>0;
  IF TG_OP='UPDATE' THEN
    NEW.is_test:=NEW.is_test OR OLD.is_test OR strpos(COALESCE(OLD.notes,''),'[TEST_PLAYER]')>0;
  END IF;
  IF NEW.is_test AND strpos(COALESCE(NEW.notes,''),'[TEST_PLAYER]')=0 THEN
    NEW.notes:=concat_ws(E'\n',NULLIF(NEW.notes,''),'[TEST_PLAYER]');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS preserve_test_player_designation ON public.players;
CREATE TRIGGER preserve_test_player_designation BEFORE INSERT OR UPDATE ON public.players
FOR EACH ROW EXECUTE FUNCTION public.preserve_test_player_designation();
UPDATE public.players SET is_test=true WHERE strpos(COALESCE(notes,''),'[TEST_PLAYER]')>0 AND NOT is_test;

-- Applies to every playbook key, including future new-signup flows that use
-- retention tables. Historical sent/skipped/closed records remain intact.
CREATE OR REPLACE FUNCTION public.reject_test_player_retention()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.players WHERE id=NEW.player_id AND club_id=NEW.club_id AND is_test) THEN
    IF TG_OP='INSERT' THEN
      RAISE EXCEPTION 'Test players are not eligible for retention' USING ERRCODE='42501';
    ELSIF TG_TABLE_NAME='retention_sequences' THEN
      IF NEW.sequence_status='active' THEN
        RAISE EXCEPTION 'Test players cannot activate retention sequences' USING ERRCODE='42501';
      END IF;
    ELSIF NEW.status NOT IN ('sent','skipped') THEN
      RAISE EXCEPTION 'Test players cannot enter retention outreach' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reject_test_player_retention ON public.retention_sequences;
CREATE TRIGGER reject_test_player_retention BEFORE INSERT OR UPDATE ON public.retention_sequences
FOR EACH ROW EXECUTE FUNCTION public.reject_test_player_retention();
DROP TRIGGER IF EXISTS reject_test_player_retention ON public.retention_candidates;
CREATE TRIGGER reject_test_player_retention BEFORE INSERT OR UPDATE ON public.retention_candidates
FOR EACH ROW EXECUTE FUNCTION public.reject_test_player_retention();

-- Classify STOP and 21610 at the database boundary, so all writers (including
-- the still-published API during rollout) inherit the same test classification.
CREATE OR REPLACE FUNCTION public.classify_test_optout_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  NEW.is_test:=COALESCE(NEW.is_test,false) OR EXISTS(
    SELECT 1 FROM public.players WHERE id=NEW.player_id AND club_id=NEW.club_id AND is_test);
  IF TG_OP='UPDATE' THEN NEW.is_test:=NEW.is_test OR OLD.is_test; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS classify_test_optout_event ON public.sms_optout_events;
CREATE TRIGGER classify_test_optout_event BEFORE INSERT OR UPDATE ON public.sms_optout_events
FOR EACH ROW EXECUTE FUNCTION public.classify_test_optout_event();
UPDATE public.sms_optout_events e SET is_test=true FROM public.players p
WHERE e.player_id=p.id AND e.club_id=p.club_id AND p.is_test AND NOT e.is_test;
CREATE OR REPLACE FUNCTION public.classify_existing_test_optouts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.is_test THEN
    UPDATE public.sms_optout_events SET is_test=true
    WHERE player_id=NEW.id AND club_id=NEW.club_id AND NOT is_test;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS classify_existing_test_optouts ON public.players;
CREATE TRIGGER classify_existing_test_optouts AFTER UPDATE OF is_test,notes ON public.players
FOR EACH ROW EXECUTE FUNCTION public.classify_existing_test_optouts();

-- Append the new column; preserve existing column order, attribution and rows.
CREATE OR REPLACE VIEW public.sms_optouts WITH (security_invoker=true) AS
SELECT e.id,e.club_id,e.player_id,COALESCE(p.name,'Unknown sender') AS name,
  e.occurred_at AS opted_out_at,
  CASE WHEN prior.id IS NULL THEN 'unattributed' ELSE e.source END AS source,
  e.source AS event_source,e.twilio_optout_type,
  prior.playbook_key,prior.step,prior.body,prior.id AS optout_message_id,e.is_test
FROM public.sms_optout_events e LEFT JOIN public.players p ON p.id=e.player_id AND p.club_id=e.club_id
LEFT JOIN LATERAL (
  SELECT m.id,m.body,candidate.playbook_key,candidate.step
  FROM public.messages m
  LEFT JOIN public.conversations c ON c.id=m.conversation_id
  LEFT JOIN public.retention_candidates candidate ON candidate.message_id=m.id AND candidate.club_id=e.club_id
  WHERE e.player_id IS NOT NULL AND m.direction='outbound' AND m.sent_at<=e.occurred_at
    AND m.status NOT IN ('pending','skipped')
    AND (m.status IN ('sent','delivered','undelivered') OR m.twilio_message_sid IS NOT NULL)
    AND (m.player_id=e.player_id OR (m.player_id IS NULL AND c.player_id=e.player_id AND c.club_id=e.club_id))
  ORDER BY m.sent_at DESC,m.id DESC LIMIT 1
) prior ON true;

-- Baseline scorecard also excludes designated test accounts.
CREATE OR REPLACE VIEW public.ltp_baseline WITH (security_invoker=true) AS
WITH first_ltp AS (
  SELECT a.club_id,a.player_id,min(a.attended_at) AS first_ltp_at
  FROM public.attendances a JOIN public.players p ON p.id=a.player_id AND p.club_id=a.club_id
  WHERE public.retention_report_is_ltp(a.program_name) AND NOT p.is_test GROUP BY a.club_id,a.player_id
), cohort AS (
  SELECT * FROM first_ltp WHERE first_ltp_at>=timestamptz '2026-04-07 00:00:00+00'
    AND first_ltp_at<timestamptz '2026-10-07 00:00:00+00'
), outcomes AS (
  SELECT c.*,EXISTS(SELECT 1 FROM public.attendances a
    WHERE a.club_id=c.club_id AND a.player_id=c.player_id AND a.booked_at>c.first_ltp_at
      AND a.booked_at<=c.first_ltp_at+interval '21 days'
      AND NOT public.retention_report_is_ltp(a.program_name)) AS booked FROM cohort c
)
SELECT club_id,count(*)::integer AS n_players,count(*) FILTER(WHERE booked)::integer AS n_booked,
  count(*) FILTER(WHERE booked)::numeric/count(*) AS rate
FROM outcomes GROUP BY club_id;
REVOKE ALL ON FUNCTION public.preserve_test_player_designation(),
  public.reject_test_player_retention(),public.classify_test_optout_event(),public.classify_existing_test_optouts()
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.preserve_test_player_designation(),
  public.reject_test_player_retention(),public.classify_test_optout_event(),public.classify_existing_test_optouts()
TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

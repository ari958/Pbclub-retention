-- DRY RUN of migration 032_winback_flow.sql. Safe to run in production.
--
-- Paste this whole file into the production Supabase SQL Editor and run it.
-- It executes every statement of migration 032 inside one transaction, checks
-- the result, and then raises an error on purpose. The error is what throws
-- the transaction away: nothing below is ever saved, whichever way it ends.
--
-- Read the error message:
--   "DRY RUN PASSED. Nothing was saved..."   -> safe to run the real migration.
--   "DRY RUN FAILED..." or any other error    -> do not apply; send the message.
--
-- The body between the markers is migration 032 verbatim (a test enforces this).
-- ---- BEGIN migration 032 body ----
BEGIN;

INSERT INTO public.retention_playbooks(
  key, name, enabled, promo_code, offer_text, next_program_names,
  message_guidance, holdout_pct, flow_kind, booking_url
) VALUES (
  'winback_regular', 'Lapsing regular win-back', true, NULL, NULL, '{}',
  'Code-built templates only (src/lib/winback.ts). No promo codes.', 20, 'single',
  'https://pbclub.podplay.app'
) ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.retention_winback_create_candidate(
  p_club_id uuid, p_player_id uuid, p_trigger_key text,
  p_context jsonb, p_status text, p_body text DEFAULT NULL,
  p_min_gap_days integer DEFAULT 90
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid := gen_random_uuid(); v_msg_id uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.players WHERE id=p_player_id AND club_id=p_club_id) THEN
    RAISE EXCEPTION 'Player does not belong to club';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.retention_playbooks
                WHERE key='winback_regular' AND enabled AND flow_kind='single') THEN
    RAISE EXCEPTION 'Win-back playbook is not enabled';
  END IF;
  IF p_min_gap_days IS NULL OR p_min_gap_days < 30 THEN
    RAISE EXCEPTION 'Win-back minimum gap must be at least 30 days';
  END IF;
  IF length(btrim(COALESCE(p_trigger_key,'')))=0 THEN
    RAISE EXCEPTION 'Win-back trigger key is required';
  END IF;
  IF p_context IS NULL OR jsonb_typeof(p_context)<>'object' THEN
    RAISE EXCEPTION 'Candidate context must be a JSON object';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('drafted','needs_context','skipped') THEN
    RAISE EXCEPTION 'Unsupported win-back candidate status';
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

  -- One writer at a time per player, so two runs cannot both start a cycle.
  PERFORM pg_advisory_xact_lock(hashtextextended('retention_winback:'||p_player_id::text, 0));

  IF EXISTS(SELECT 1 FROM public.retention_candidates
            WHERE player_id=p_player_id AND playbook_key='winback_regular'
              AND prelaunch_superseded_by IS NULL
              AND (created_at > now() - make_interval(days => p_min_gap_days)
                   OR status='approved')) THEN
    RETURN NULL;
  END IF;

  UPDATE public.retention_candidates SET prelaunch_superseded_by=v_id
  WHERE player_id=p_player_id AND playbook_key='winback_regular' AND step=1
    AND prelaunch_superseded_by IS NULL;

  INSERT INTO public.retention_candidates(id,club_id,player_id,playbook_key,trigger_event_id,context,status)
  VALUES(v_id,p_club_id,p_player_id,'winback_regular',p_trigger_key,p_context,p_status);

  IF p_status='drafted' THEN
    INSERT INTO public.messages(player_id,body,direction,sent_by,status,sent_at)
    VALUES(p_player_id,btrim(p_body),'outbound','agent','pending',NULL)
    RETURNING id INTO v_msg_id;
    UPDATE public.retention_candidates SET message_id=v_msg_id WHERE id=v_id;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.retention_winback_create_candidate(uuid,uuid,text,jsonb,text,text,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retention_winback_create_candidate(uuid,uuid,text,jsonb,text,text,integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.retention_winback_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.retention_playbooks WHERE key='winback_regular' AND flow_kind='single')
     AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='public' AND p.proname='retention_winback_create_candidate')
$$;
REVOKE ALL ON FUNCTION public.retention_winback_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retention_winback_ready() TO service_role;


-- ---- END migration 032 body ----

DO $dryrun$
DECLARE v_ready boolean; v_row text; v_ltp text;
BEGIN
  v_ready := public.retention_winback_ready();
  SELECT format('%s / %s / enabled=%s / holdout=%s%% / promo=%s', key, flow_kind, enabled, holdout_pct, coalesce(promo_code,'none'))
    INTO v_row FROM public.retention_playbooks WHERE key='winback_regular';
  SELECT format('%s / %s / enabled=%s', key, flow_kind, enabled)
    INTO v_ltp FROM public.retention_playbooks WHERE key='ltp_followup';
  IF v_ready IS DISTINCT FROM true OR v_row IS NULL THEN
    RAISE EXCEPTION 'DRY RUN FAILED: migration 032 ran, but retention_winback_ready() is not true. Nothing was saved. Row: %', coalesce(v_row,'missing');
  END IF;
  RAISE EXCEPTION 'DRY RUN PASSED. Nothing was saved (this error is raised on purpose so the transaction rolls back). retention_winback_ready = true; %; Learn to Play unchanged: %', v_row, coalesce(v_ltp,'missing');
END $dryrun$;
ROLLBACK;

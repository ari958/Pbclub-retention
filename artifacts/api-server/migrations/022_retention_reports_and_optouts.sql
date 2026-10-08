-- External Supabase SQL Editor only. Apply before publishing the updated API.
-- No approvals, sends, settings or playbook configuration are changed.
BEGIN;
ALTER TABLE public.sms_inbound_receipts ADD COLUMN IF NOT EXISTS twilio_optout_type text;
CREATE TABLE IF NOT EXISTS public.sms_optout_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  player_id uuid REFERENCES public.players(id),
  occurred_at timestamptz,
  source text NOT NULL CHECK(source IN ('stop_reply','carrier_21610','manual')),
  twilio_optout_type text,
  inbound_receipt_id uuid UNIQUE REFERENCES public.sms_inbound_receipts(id),
  message_id uuid UNIQUE REFERENCES public.messages(id),
  alerted_at timestamptz,
  is_backfill boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sms_optout_events_manual_player
  ON public.sms_optout_events(player_id) WHERE source='manual' AND player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_optout_events_club_time
  ON public.sms_optout_events(club_id,occurred_at DESC);
ALTER TABLE public.sms_optout_events ENABLE ROW LEVEL SECURITY;

-- Backfills are permanently marked so a later webhook replay cannot alert them.
INSERT INTO public.sms_optout_events
  (club_id,player_id,occurred_at,source,twilio_optout_type,inbound_receipt_id,is_backfill)
SELECT club_id,player_id,received_at,'stop_reply',twilio_optout_type,id,true
FROM public.sms_inbound_receipts
WHERE kind='stop' OR upper(btrim(twilio_optout_type))='STOP'
ON CONFLICT(inbound_receipt_id) DO NOTHING;
INSERT INTO public.sms_optout_events
  (club_id,player_id,occurred_at,source,message_id,is_backfill)
SELECT p.club_id,p.id,
  -- Never substitute send time for an unknown historical callback time.
  COALESCE(NULLIF(to_jsonb(m)->>'status_callback_at','')::timestamptz,
           NULLIF(to_jsonb(m)->>'callback_at','')::timestamptz),
  'carrier_21610',m.id,true
FROM public.messages m
LEFT JOIN public.conversations c ON c.id=m.conversation_id
JOIN public.players p ON p.id=COALESCE(m.player_id,c.player_id)
WHERE m.error_code::text='21610'
ON CONFLICT(message_id) DO NOTHING;
INSERT INTO public.sms_optout_events
  (club_id,player_id,occurred_at,source,is_backfill)
SELECT p.club_id,p.id,
  COALESCE(NULLIF(to_jsonb(p)->>'opted_out_at','')::timestamptz,
           NULLIF(to_jsonb(p)->>'sms_opted_out_at','')::timestamptz),
  'manual',true
FROM public.players p
WHERE p.opted_out IS TRUE AND NOT EXISTS
  (SELECT 1 FROM public.sms_optout_events e WHERE e.player_id=p.id)
ON CONFLICT DO NOTHING;

-- Preserve the existing receipt transaction, player enforcement, and retry
-- semantics; add provider-authoritative classification and an idempotent event.
CREATE OR REPLACE FUNCTION public.capture_sms_inbound(
  p_club_slug text,p_from text,p_to text,p_sid text,p_body text,p_optout_type text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE club uuid; player uuid; matches uuid[]; digits text; k text; conv uuid;
  r public.sms_inbound_receipts%ROWTYPE; replay boolean:=false;
  event_id uuid; event_created boolean:=false; mismatch boolean:=false;
BEGIN
  IF p_sid IS NULL OR p_sid !~ '^SM[0-9a-fA-F]{32}$'
    OR p_from IS NULL OR p_from !~ '^\+[1-9][0-9]{7,14}$'
    OR p_to IS NULL OR p_to !~ '^\+[1-9][0-9]{7,14}$' OR p_body IS NULL THEN
    RAISE EXCEPTION 'Invalid inbound payload';
  END IF;
  SELECT id INTO STRICT club FROM public.clubs WHERE slug=p_club_slug;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_sid,0));
  k:=CASE WHEN lower(btrim(p_body)) IN ('stop','stopall','unsubscribe','cancel','end','quit') THEN 'stop'
    WHEN lower(btrim(p_body)) IN ('start','yes','unstop') THEN 'start' ELSE 'reply' END;
  SELECT * INTO r FROM public.sms_inbound_receipts WHERE twilio_message_sid=p_sid FOR UPDATE;
  IF FOUND THEN
    replay:=r.processed_at IS NOT NULL;
    IF r.club_id<>club OR r.from_phone<>p_from OR r.to_phone<>p_to OR r.body<>p_body
      OR (r.twilio_optout_type IS NOT NULL AND p_optout_type IS NOT NULL
          AND r.twilio_optout_type<>p_optout_type) THEN
      RAISE EXCEPTION 'Inbound SID payload conflict';
    END IF;
    mismatch:=upper(btrim(COALESCE(p_optout_type,r.twilio_optout_type)))='STOP' AND k<>'stop';
    UPDATE public.sms_inbound_receipts SET
      twilio_optout_type=COALESCE(twilio_optout_type,p_optout_type),
      kind=CASE WHEN upper(btrim(COALESCE(p_optout_type,twilio_optout_type)))='STOP' THEN 'stop' ELSE kind END,
      processed_at=CASE WHEN upper(btrim(COALESCE(p_optout_type,twilio_optout_type)))='STOP'
        AND kind<>'stop' THEN NULL ELSE processed_at END
    WHERE id=r.id RETURNING * INTO r;
  ELSE
    mismatch:=upper(btrim(p_optout_type))='STOP' AND k<>'stop';
    IF upper(btrim(p_optout_type))='STOP' THEN k:='stop'; END IF;
    digits:=regexp_replace(p_from,'[^0-9]','','g');
    IF length(digits)=11 AND left(digits,1)='1' THEN digits:=substring(digits,2); END IF;
    SELECT array_agg(id ORDER BY id) INTO matches FROM public.players
      WHERE club_id=club AND
      CASE WHEN length(regexp_replace(phone,'[^0-9]','','g'))=11
        AND left(regexp_replace(phone,'[^0-9]','','g'),1)='1'
        THEN substring(regexp_replace(phone,'[^0-9]','','g'),2)
        ELSE regexp_replace(phone,'[^0-9]','','g') END=digits;
    IF cardinality(matches)=1 THEN player:=matches[1]; END IF;
    INSERT INTO public.sms_inbound_receipts
      (club_id,player_id,twilio_message_sid,from_phone,to_phone,body,kind,match_reason,twilio_optout_type)
    VALUES(club,player,p_sid,p_from,p_to,p_body,k,
      CASE WHEN player IS NOT NULL THEN 'matched' WHEN cardinality(matches)>1 THEN 'ambiguous' ELSE 'unknown' END,
      p_optout_type) RETURNING * INTO r;
    IF player IS NOT NULL THEN
      SELECT id INTO conv FROM public.conversations WHERE player_id=player AND club_id=club
        ORDER BY created_at DESC,id DESC LIMIT 1;
      IF conv IS NULL THEN
        INSERT INTO public.conversations(player_id,club_id,triggered_by)
          VALUES(player,club,'inbound') RETURNING id INTO conv;
      END IF;
      INSERT INTO public.messages(player_id,conversation_id,body,direction,sent_by,status,twilio_message_sid,sent_at)
        VALUES(player,conv,p_body,'inbound','player','sent',p_sid,r.received_at) RETURNING id INTO r.message_id;
      UPDATE public.sms_inbound_receipts SET message_id=r.message_id WHERE id=r.id;
    END IF;
  END IF;
  IF r.processed_at IS NULL THEN
    IF r.player_id IS NOT NULL AND r.kind='stop' THEN
      UPDATE public.players SET sms_opt_in=false,opted_out=true WHERE id=r.player_id AND club_id=club;
    END IF;
    BEGIN
      IF r.player_id IS NOT NULL THEN
        IF r.kind='start' THEN
          UPDATE public.players SET sms_opt_in=true,opted_out=false WHERE id=r.player_id AND club_id=club;
        ELSE
          IF EXISTS(SELECT 1 FROM public.retention_sequences WHERE club_id=club AND player_id=r.player_id
            AND playbook_key='ltp_followup' AND (r.kind='stop' OR sequence_status='active')) THEN
            PERFORM public.retention_sequence_transition(club,r.player_id,'ltp_followup',
              CASE WHEN r.kind='stop' THEN 'exited_opt_out' ELSE 'paused_reply' END,
              CASE WHEN r.kind='stop' THEN 'inbound_stop' ELSE 'inbound_reply' END,NULL);
          END IF;
          IF r.kind='stop' THEN
            UPDATE public.messages SET status='skipped',error_message='Player opted out via STOP'
              WHERE status='pending' AND dispatch_claimed_at IS NULL AND dispatch_token IS NULL
              AND (player_id=r.player_id OR conversation_id IN
                (SELECT id FROM public.conversations WHERE player_id=r.player_id AND club_id=club));
          END IF;
        END IF;
      END IF;
      UPDATE public.sms_inbound_receipts SET processed_at=clock_timestamp(),processing_error=NULL
        WHERE id=r.id RETURNING * INTO r;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.sms_inbound_receipts SET processing_error='Sequence processing failed: '||SQLSTATE
        WHERE id=r.id RETURNING * INTO r;
    END;
  END IF;
  IF r.kind='stop' THEN
    INSERT INTO public.sms_optout_events
      (club_id,player_id,occurred_at,source,twilio_optout_type,inbound_receipt_id)
    VALUES(club,r.player_id,r.received_at,'stop_reply',r.twilio_optout_type,r.id)
    ON CONFLICT(inbound_receipt_id) DO NOTHING RETURNING id INTO event_id;
    event_created:=event_id IS NOT NULL;
    IF event_id IS NULL THEN
      SELECT id INTO event_id FROM public.sms_optout_events WHERE inbound_receipt_id=r.id;
    END IF;
  END IF;
  RETURN to_jsonb(r)||jsonb_build_object('duplicate',replay,'optout_event_id',event_id,
    'optout_event_created',event_created,'optout_type_mismatch',COALESCE(mismatch,false));
END $$;
-- Keep the previous API compatible during the migration-before-publish interval.
CREATE OR REPLACE FUNCTION public.capture_sms_inbound(
  p_club_slug text,p_from text,p_to text,p_sid text,p_body text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT public.capture_sms_inbound(p_club_slug,p_from,p_to,p_sid,p_body,NULL);
$$;

-- Same NFKC, lowercase, hyphen/underscore replacement, whitespace collapse
-- and ASCII word boundaries as isLearnToPlayName/normalizeRetentionName.
CREATE OR REPLACE FUNCTION public.retention_report_is_ltp(p_name text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(regexp_replace(
    translate(lower(normalize(p_name,NFKC)),U&'\2010\2011\2012\2013\2014\2015_-',repeat(' ',8)),
    '[[:space:]]+',' ','g')
    ~ '(^|[^A-Za-z0-9_])learn to play([^A-Za-z0-9_]|$)',false);
$$;

CREATE OR REPLACE VIEW public.sms_optouts WITH (security_invoker=true) AS
SELECT e.id,e.club_id,e.player_id,COALESCE(p.name,'Unknown sender') AS name,
  e.occurred_at AS opted_out_at,
  CASE WHEN prior.id IS NULL THEN 'unattributed' ELSE e.source END AS source,
  e.source AS event_source,e.twilio_optout_type,
  prior.playbook_key,prior.step,prior.body,prior.id AS optout_message_id
FROM public.sms_optout_events e
LEFT JOIN public.players p ON p.id=e.player_id AND p.club_id=e.club_id
LEFT JOIN LATERAL (
  SELECT m.id,m.body,candidate.playbook_key,candidate.step
  FROM public.messages m
  LEFT JOIN public.conversations c ON c.id=m.conversation_id
  LEFT JOIN public.retention_candidates candidate ON candidate.message_id=m.id AND candidate.club_id=e.club_id
  WHERE e.player_id IS NOT NULL AND m.direction='outbound' AND m.sent_at<=e.occurred_at
    -- Legacy pending drafts can have a creation-time sent_at default.
    AND m.status NOT IN ('pending','skipped')
    AND (m.status IN ('sent','delivered','undelivered') OR m.twilio_message_sid IS NOT NULL)
    AND (m.player_id=e.player_id OR (m.player_id IS NULL AND c.player_id=e.player_id AND c.club_id=e.club_id))
  ORDER BY m.sent_at DESC,m.id DESC LIMIT 1
) prior ON true;

CREATE OR REPLACE VIEW public.playbook_outcomes WITH (security_invoker=true) AS
WITH config AS (SELECT interval '14 days' AS booking_window)
SELECT s.id AS sequence_id,s.club_id,s.player_id,COALESCE(p.name,'Unknown player') AS name,s.playbook_key,
  s.step1_sent_at,s.step2_sent_at,GREATEST(s.step1_sent_at,s.step2_sent_at) AS last_sent_at,
  s.sequence_status,s.exit_reason,
  (EXISTS(SELECT 1 FROM public.sms_inbound_receipts r WHERE r.club_id=s.club_id AND r.player_id=s.player_id
    AND r.kind='reply' AND r.received_at>s.step1_sent_at)
   OR EXISTS(SELECT 1 FROM public.messages im LEFT JOIN public.conversations ic ON ic.id=im.conversation_id
     WHERE im.direction='inbound' AND im.sent_at>s.step1_sent_at
       AND (im.player_id=s.player_id OR (im.player_id IS NULL AND ic.player_id=s.player_id AND ic.club_id=s.club_id))
       AND lower(btrim(im.body)) NOT IN ('stop','stopall','unsubscribe','cancel','end','quit','start','yes','unstop')
       AND NOT EXISTS(SELECT 1 FROM public.sms_inbound_receipts r WHERE r.message_id=im.id AND r.kind<>'reply'))
  ) AS replied,
  b.event_id IS NOT NULL AS booked,b.event_id AS booked_event_id,b.program_name AS booked_program_name,
  b.booked_at AS booking_created_at,b.credited_step,b.coupon_code AS coupon_code_used,
  round(extract(epoch FROM (b.booked_at-s.step1_sent_at))/86400,2) AS days_to_book,
  o.id IS NOT NULL AS opted_out,o.opted_out_at,o.step AS optout_after_step,o.optout_message_id,
  round(extract(epoch FROM (o.opted_out_at-
    CASE WHEN o.step=2 THEN s.step2_sent_at ELSE s.step1_sent_at END))/3600,2) AS hours_to_optout,
  c1.id IS NOT NULL AND NULLIF(btrim(m1.body),'') IS NOT NULL AS step1_drafted,
  m1.approved_at IS NOT NULL AS step1_approved,
  s.step1_sent_at IS NOT NULL AS step1_sent,
  s.step1_sent_at IS NOT NULL AND (m1.delivered_at IS NOT NULL OR COALESCE(m1.delivery_status='delivered',false)) AS step1_delivered,
  COALESCE(b.credited_step=1,false) AS step1_booked,
  c2.id IS NOT NULL AND NULLIF(btrim(m2.body),'') IS NOT NULL AS step2_drafted,
  m2.approved_at IS NOT NULL AS step2_approved,
  s.step2_sent_at IS NOT NULL AS step2_sent,
  s.step2_sent_at IS NOT NULL AND (m2.delivered_at IS NOT NULL OR COALESCE(m2.delivery_status='delivered',false)) AS step2_delivered,
  COALESCE(b.credited_step=2,false) AS step2_booked
FROM public.retention_sequences s
CROSS JOIN config
LEFT JOIN public.players p ON p.id=s.player_id AND p.club_id=s.club_id
LEFT JOIN public.retention_candidates c1 ON c1.sequence_id=s.id AND c1.step=1 AND c1.prelaunch_superseded_by IS NULL
LEFT JOIN public.retention_candidates c2 ON c2.sequence_id=s.id AND c2.step=2 AND c2.prelaunch_superseded_by IS NULL
LEFT JOIN public.messages m1 ON m1.id=COALESCE(s.step1_message_id,c1.message_id)
LEFT JOIN public.messages m2 ON m2.id=COALESCE(s.step2_message_id,c2.message_id)
LEFT JOIN LATERAL (
  SELECT a.event_id,a.program_name,a.booked_at,a.coupon_code,
    CASE WHEN s.step2_sent_at IS NOT NULL AND a.booked_at>s.step2_sent_at THEN 2 ELSE 1 END AS credited_step
  FROM public.attendances a
  WHERE a.club_id=s.club_id AND a.player_id=s.player_id AND a.booked_at>s.step1_sent_at
    AND a.booked_at<=GREATEST(s.step1_sent_at,s.step2_sent_at)+config.booking_window
    AND NOT public.retention_report_is_ltp(a.program_name)
  ORDER BY a.booked_at,a.event_id LIMIT 1
) b ON true
LEFT JOIN LATERAL (
  SELECT opt.id,opt.opted_out_at,opt.step,opt.optout_message_id
  FROM public.sms_optouts opt
  WHERE opt.club_id=s.club_id AND opt.player_id=s.player_id
    AND opt.optout_message_id IN (s.step1_message_id,s.step2_message_id)
    AND opt.opted_out_at>=s.step1_sent_at
  ORDER BY opt.opted_out_at,opt.id LIMIT 1
) o ON true;

CREATE OR REPLACE VIEW public.ltp_baseline WITH (security_invoker=true) AS
WITH first_ltp AS (
  SELECT club_id,player_id,min(attended_at) AS first_ltp_at FROM public.attendances
  WHERE public.retention_report_is_ltp(program_name) GROUP BY club_id,player_id
), cohort AS (
  SELECT * FROM first_ltp WHERE first_ltp_at>=timestamptz '2026-04-07 00:00:00+00'
    AND first_ltp_at<timestamptz '2026-10-07 00:00:00+00'
), outcomes AS (
  SELECT c.*,EXISTS(SELECT 1 FROM public.attendances a
    WHERE a.club_id=c.club_id AND a.player_id=c.player_id AND a.booked_at>c.first_ltp_at
      AND a.booked_at<=c.first_ltp_at+interval '21 days'
      AND NOT public.retention_report_is_ltp(a.program_name)) AS booked
  FROM cohort c
)
SELECT club_id,count(*)::integer AS n_players,count(*) FILTER(WHERE booked)::integer AS n_booked,
  count(*) FILTER(WHERE booked)::numeric/count(*) AS rate
FROM outcomes GROUP BY club_id;

-- Run grants after all additions. These views never receive browser access.
REVOKE ALL ON public.sms_optout_events,public.sms_inbound_receipts,
  public.playbook_outcomes,public.sms_optouts,public.ltp_baseline FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.sms_optout_events,public.sms_inbound_receipts TO service_role;
GRANT SELECT ON public.playbook_outcomes,public.sms_optouts,public.ltp_baseline TO service_role;
REVOKE ALL ON FUNCTION public.capture_sms_inbound(text,text,text,text,text),
  public.capture_sms_inbound(text,text,text,text,text,text),public.retention_report_is_ltp(text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.capture_sms_inbound(text,text,text,text,text),
  public.capture_sms_inbound(text,text,text,text,text,text),public.retention_report_is_ltp(text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

-- Read-only verification: retain this output after applying in SQL Editor.
SELECT sources.source,count(e.id) AS backfilled_events
FROM (VALUES('stop_reply'),('carrier_21610'),('manual')) sources(source)
LEFT JOIN public.sms_optout_events e ON e.source=sources.source AND e.is_backfill
GROUP BY sources.source ORDER BY sources.source;
SELECT 'playbook_outcomes' AS view,count(*) FROM public.playbook_outcomes
UNION ALL SELECT 'sms_optouts',count(*) FROM public.sms_optouts;
SELECT * FROM public.ltp_baseline;
SELECT * FROM public.sms_optouts WHERE source='unattributed';

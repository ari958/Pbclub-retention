-- External Supabase: apply manually before publishing.
-- Private inbox; no sending settings, approvals, provider configuration or
-- existing message history is changed. Unknown/ambiguous senders stay unlinked.
BEGIN;
CREATE TABLE IF NOT EXISTS public.sms_inbound_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  player_id uuid REFERENCES public.players(id),
  message_id uuid REFERENCES public.messages(id),
  twilio_message_sid text NOT NULL UNIQUE,
  from_phone text NOT NULL, to_phone text NOT NULL, body text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('reply','stop','start')),
  match_reason text NOT NULL CHECK(match_reason IN ('matched','unknown','ambiguous')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz, processing_error text,
  operator_alert_attempted_at timestamptz
);
CREATE INDEX IF NOT EXISTS sms_inbound_receipts_club_time ON public.sms_inbound_receipts(club_id,received_at DESC);
ALTER TABLE public.sms_inbound_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_inbound_receipts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.sms_inbound_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.capture_sms_inbound(
  p_club_slug text,p_from text,p_to text,p_sid text,p_body text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE club uuid; player uuid; matches uuid[]; digits text; k text; conv uuid;
  r public.sms_inbound_receipts%ROWTYPE; replay boolean:=false;
BEGIN
  IF p_sid IS NULL OR p_sid !~ '^SM[0-9a-fA-F]{32}$'
    OR p_from IS NULL OR p_from !~ '^\+[1-9][0-9]{7,14}$'
    OR p_to IS NULL OR p_to !~ '^\+[1-9][0-9]{7,14}$' OR p_body IS NULL THEN
    RAISE EXCEPTION 'Invalid inbound payload';
  END IF;
  SELECT id INTO STRICT club FROM public.clubs WHERE slug=p_club_slug;
  -- SID replay serialization, including concurrent provider retries.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_sid,0));
  SELECT * INTO r FROM public.sms_inbound_receipts WHERE twilio_message_sid=p_sid FOR UPDATE;
  IF FOUND THEN
    replay:=r.processed_at IS NOT NULL;
    IF r.club_id<>club OR r.from_phone<>p_from OR r.to_phone<>p_to OR r.body<>p_body THEN
      RAISE EXCEPTION 'Inbound SID payload conflict';
    END IF;
  ELSE
    digits:=regexp_replace(p_from,'[^0-9]','','g');
    IF length(digits)=11 AND left(digits,1)='1' THEN digits:=substring(digits,2); END IF;
    SELECT array_agg(id ORDER BY id) INTO matches FROM public.players
      WHERE club_id=club AND
      CASE WHEN length(regexp_replace(phone,'[^0-9]','','g'))=11
        AND left(regexp_replace(phone,'[^0-9]','','g'),1)='1'
        THEN substring(regexp_replace(phone,'[^0-9]','','g'),2)
        ELSE regexp_replace(phone,'[^0-9]','','g') END=digits;
    IF cardinality(matches)=1 THEN player:=matches[1]; END IF;
    k:=CASE WHEN lower(btrim(p_body)) IN ('stop','stopall','unsubscribe','cancel','end','quit') THEN 'stop'
      WHEN lower(btrim(p_body)) IN ('start','yes','unstop') THEN 'start' ELSE 'reply' END;
    INSERT INTO public.sms_inbound_receipts(club_id,player_id,twilio_message_sid,from_phone,to_phone,body,kind,match_reason)
      VALUES(club,player,p_sid,p_from,p_to,p_body,k,
        CASE WHEN player IS NOT NULL THEN 'matched' WHEN cardinality(matches)>1 THEN 'ambiguous' ELSE 'unknown' END)
      RETURNING * INTO r;
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
    -- Preserve the receipt even if sequence processing fails. Provider retry
    -- reuses the same receipt/message and retries only uncompleted effects.
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
  RETURN to_jsonb(r)||jsonb_build_object('duplicate',replay);
END $$;
REVOKE ALL ON FUNCTION public.capture_sms_inbound(text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.capture_sms_inbound(text,text,text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;

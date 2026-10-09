-- Prepared only: do not apply automatically.
-- Function-only repair of the six-argument overload from migration 022.
-- Only change: conversations ordering uses opened_at instead of created_at.
-- Existing owner, grants, five-argument overload, tables and views are untouched.
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
        ORDER BY opened_at DESC,id DESC LIMIT 1;
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

-- Run manually in Supabase SQL Editor after installing 028.
-- NOT a migration. Do not execute through the HTTP webhook or application.
-- All DB effects are rolled back. No provider transport or approval RPC is called.
BEGIN;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.sms_inbound_receipts WHERE twilio_message_sid='SM00000000000000000000000000000000')
     OR EXISTS(SELECT 1 FROM public.messages WHERE twilio_message_sid='SM00000000000000000000000000000000') THEN
    RAISE EXCEPTION 'Verification SID is already used; abort rather than touch its history';
  END IF;
  IF (SELECT count(*) FROM public.players p JOIN public.clubs c ON c.id=p.club_id
      WHERE c.slug='pb-club' AND regexp_replace(p.phone,'[^0-9]','','g') IN ('12013783810','2013783810'))<>1
     OR NOT EXISTS(SELECT 1 FROM public.players p JOIN public.clubs c ON c.id=p.club_id
      WHERE c.slug='pb-club' AND regexp_replace(p.phone,'[^0-9]','','g') IN ('12013783810','2013783810')
        AND (p.is_test OR strpos(COALESCE(p.notes,''),'[TEST_PLAYER]')>0)) THEN
    RAISE EXCEPTION 'Verification requires exactly one matching, designated PB Club test player';
  END IF;
END $$;

SAVEPOINT normal_reply;
SELECT public.capture_sms_inbound(
  'pb-club','+12013783810','+12015281834',
  'SM00000000000000000000000000000000','Verification reply',NULL::text);
SELECT r.kind,r.match_reason,r.player_id,r.processed_at,r.processing_error,
  m.direction,c.opened_at,c.updated_at
FROM public.sms_inbound_receipts r
LEFT JOIN public.messages m ON m.id=r.message_id
LEFT JOIN public.conversations c ON c.id=m.conversation_id
WHERE r.twilio_message_sid='SM00000000000000000000000000000000';
ROLLBACK TO SAVEPOINT normal_reply;

SAVEPOINT stop;
SELECT public.capture_sms_inbound(
  'pb-club','+12013783810','+12015281834',
  'SM00000000000000000000000000000000','STOP','STOP');
SELECT r.kind,r.match_reason,r.processed_at,r.processing_error,
  p.opted_out,p.sms_opt_in,p.is_test,e.is_test AS event_is_test
FROM public.sms_inbound_receipts r
LEFT JOIN public.players p ON p.id=r.player_id AND p.club_id=r.club_id
LEFT JOIN public.sms_optout_events e ON e.inbound_receipt_id=r.id
WHERE r.twilio_message_sid='SM00000000000000000000000000000000';
ROLLBACK TO SAVEPOINT stop;

SAVEPOINT start;
SELECT public.capture_sms_inbound(
  'pb-club','+12013783810','+12015281834',
  'SM00000000000000000000000000000000','START','START');
SELECT r.kind,r.match_reason,r.processed_at,r.processing_error,
  p.opted_out,p.sms_opt_in,p.is_test
FROM public.sms_inbound_receipts r
LEFT JOIN public.players p ON p.id=r.player_id AND p.club_id=r.club_id
WHERE r.twilio_message_sid='SM00000000000000000000000000000000';
ROLLBACK;

-- Both counts must be zero, confirming no verification SID was retained.
SELECT
  (SELECT count(*) FROM public.sms_inbound_receipts WHERE twilio_message_sid='SM00000000000000000000000000000000') AS receipt_count,
  (SELECT count(*) FROM public.messages WHERE twilio_message_sid='SM00000000000000000000000000000000') AS message_count;

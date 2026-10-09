-- Applied manually in the Supabase SQL Editor on 2026-10-08. VIEW CHANGES ONLY.
-- Migration 023 is already applied. Do not rerun 022 or 023.
-- The SELECT counts below are retained for verification.
BEGIN;

-- Step 1: preserve the existing column order and sent-only production cohort.
-- Do not replace public.playbook_outcomes: its definition remains unchanged.
CREATE OR REPLACE VIEW public.playbook_outcomes_audit WITH (security_invoker=true) AS
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
  COALESCE(b.credited_step=2,false) AS step2_booked,
  CASE WHEN b.event_id IS NOT NULL THEN 'booked'
       WHEN now()<=w.window_closes_at THEN 'in_window'
       WHEN s.step1_sent_at IS NULL THEN 'not_started'
       ELSE 'no_booking' END AS outcome,
  w.window_closes_at,
  (COALESCE(s.step1_delivery_kind='test',false)
    OR (s.step1_sent_at IS NOT NULL AND COALESCE(m1.retention_delivery_kind='test',false))
    OR (s.step2_sent_at IS NOT NULL AND COALESCE(m2.retention_delivery_kind='test',false))
    OR EXISTS(SELECT 1 FROM public.contact_ledger l WHERE l.club_id=s.club_id
      AND l.message_id IN (s.step1_message_id,s.step2_message_id) AND l.is_test)
    OR EXISTS(SELECT 1 FROM public.retention_ltp_test_controls t WHERE t.club_id=s.club_id AND t.sequence_id=s.id)
  ) AS is_test
FROM public.retention_sequences s
CROSS JOIN config
LEFT JOIN public.players p ON p.id=s.player_id AND p.club_id=s.club_id
LEFT JOIN public.retention_candidates c1 ON c1.sequence_id=s.id AND c1.club_id=s.club_id AND c1.step=1 AND c1.prelaunch_superseded_by IS NULL
LEFT JOIN public.retention_candidates c2 ON c2.sequence_id=s.id AND c2.club_id=s.club_id AND c2.step=2 AND c2.prelaunch_superseded_by IS NULL
LEFT JOIN public.messages m1 ON m1.id=COALESCE(s.step1_message_id,c1.message_id)
LEFT JOIN public.messages m2 ON m2.id=COALESCE(s.step2_message_id,c2.message_id)
CROSS JOIN LATERAL (
  SELECT CASE WHEN s.step1_sent_at IS NULL THEN NULL::timestamptz
    ELSE GREATEST(s.step1_sent_at+interval '7 days',s.step2_sent_at)+config.booking_window END AS window_closes_at
) w
LEFT JOIN LATERAL (
  SELECT a.event_id,a.program_name,a.booked_at,a.coupon_code,
    CASE WHEN s.step2_sent_at IS NOT NULL AND a.booked_at>s.step2_sent_at THEN 2 ELSE 1 END AS credited_step
  FROM public.attendances a
  WHERE a.club_id=s.club_id AND a.player_id=s.player_id AND a.booked_at>s.step1_sent_at
    AND a.booked_at<=w.window_closes_at
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
REVOKE ALL ON public.playbook_outcomes_audit FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.playbook_outcomes_audit TO service_role;

COMMIT;

SELECT outcome,count(*) AS sequences
FROM public.playbook_outcomes_audit
WHERE playbook_key='ltp_followup' AND club_id=(
  SELECT id FROM public.clubs WHERE slug='pb-club'
)
GROUP BY outcome ORDER BY outcome;
SELECT count(*) AS sent_non_test_sequences
FROM public.playbook_outcomes
WHERE playbook_key='ltp_followup' AND club_id=(
  SELECT id FROM public.clubs WHERE slug='pb-club'
);

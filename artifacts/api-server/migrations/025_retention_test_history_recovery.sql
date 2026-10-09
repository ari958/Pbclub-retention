-- DRY-RUN PROPOSAL ONLY. DO NOT APPLY without renewed live booking checks.
-- Leave uniqueness, conflict targets, and message rows completely untouched.
-- This transaction refuses recovery unless an operator supplies a fresh
-- live-check timestamp and identity in the same SQL session. No draft/send RPC
-- is called: normal pipeline drafting remains a separate, approval-only step.
BEGIN;
CREATE TABLE IF NOT EXISTS public.retention_test_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  player_id uuid NOT NULL REFERENCES public.players(id),
  sequence_id uuid NOT NULL REFERENCES public.retention_sequences(id),
  original_step1_message_id uuid NOT NULL,
  sequence_snapshot jsonb NOT NULL,
  candidates_snapshot jsonb NOT NULL,
  messages_snapshot jsonb NOT NULL,
  ledger_snapshot jsonb NOT NULL,
  test_control_snapshot jsonb,
  report_snapshot jsonb NOT NULL,
  message_destinations jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  operator text NOT NULL,
  UNIQUE(sequence_id,original_step1_message_id)
);
ALTER TABLE public.retention_test_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.retention_test_history FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.retention_test_history TO service_role;

-- The provider destinations below were independently fetched read-only.
-- Never infer them from is_test or from a player's current phone.
DO $recovery$
DECLARE s public.retention_sequences%ROWTYPE; entry jsonb; destinations jsonb;
  checked_at timestamptz; actor text; current_report jsonb; linked_ids uuid[];
BEGIN
  checked_at:=NULLIF(current_setting('app.retention_recovery_live_checked_at',true),'')::timestamptz;
  actor:=NULLIF(btrim(current_setting('app.retention_recovery_operator',true)),'');
  IF checked_at IS NULL OR checked_at>now() OR checked_at<now()-interval '5 minutes' OR actor IS NULL THEN
    RAISE EXCEPTION 'Refresh all four live upcoming-signup checks and supply a fresh checked-at timestamp and operator; 025 remains unapplied';
  END IF;
  -- Recheck all candidates against the read-only audit before authorizing this
  -- transaction. The original step-1 ID is the compare-and-set identity.
  FOR entry IN SELECT value FROM jsonb_array_elements('[
    {"sequence_id":"965a9fdd-0184-4b70-a17a-1481458fc183","step1":"dc31720d-2f27-4fa8-a889-20ec95791b2f",
     "destinations":[{"message_id":"dc31720d-2f27-4fa8-a889-20ec95791b2f","twilio_message_sid":"SM051963d7b82890ac49cacaef188902b2","to":"+12013702546"}]},
    {"sequence_id":"34f552a1-094d-401c-bfa6-e2a976c8393b","step1":"fca8dc6f-1333-4c1e-8cc0-bb9a70e196fc",
     "destinations":[{"message_id":"fca8dc6f-1333-4c1e-8cc0-bb9a70e196fc","twilio_message_sid":"SMc950bc8f34fe7f9374e93a04f08e855e","to":"+12013702546"}]},
    {"sequence_id":"5ff2ab6a-4c12-4dae-aa56-634b89510659","step1":"36f60a30-5c02-433c-bbed-238077472b7f",
     "destinations":[{"message_id":"36f60a30-5c02-433c-bbed-238077472b7f","twilio_message_sid":"SM1166b95efd83680f36e6bd8019ee0271","to":"+12013702546"}]},
    {"sequence_id":"b755e667-19a8-4491-a849-4ae34127478d","step1":"b4174321-c6a1-48b7-bed8-d81aeb72247f",
     "destinations":[{"message_id":"b4174321-c6a1-48b7-bed8-d81aeb72247f","twilio_message_sid":"SMbacb212333ea47454d5152f521f83350","to":"+12013702546"},
       {"message_id":"5005b574-d615-458b-b206-eaa155749f5f","twilio_message_sid":"SM505fa95ee49e37789eeb12ca581da5f9","to":"+12013702546"}]}
  ]'::jsonb)
  LOOP
    SELECT * INTO s FROM public.retention_sequences WHERE id=(entry->>'sequence_id')::uuid
      AND club_id=(SELECT id FROM public.clubs WHERE slug='pb-club') AND playbook_key='ltp_followup' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recovery sequence not found'; END IF;
    -- Reapplication is a no-op for a root that was already recovered.
    IF EXISTS(SELECT 1 FROM public.retention_test_history
      WHERE sequence_id=s.id AND original_step1_message_id=(entry->>'step1')::uuid)
      AND s.step1_sent_at IS NULL AND s.step1_message_id IS NULL THEN CONTINUE; END IF;
    IF s.step1_message_id IS DISTINCT FROM (entry->>'step1')::uuid
      OR s.step1_sent_at IS NULL OR s.step1_delivery_kind IS DISTINCT FROM 'test' THEN
      RAISE EXCEPTION 'Recovery identity or original test evidence changed';
    END IF;
    -- Ke's stored exit is a test-simulated booking, not a real booking.
    IF (s.sequence_status='exited_booked' AND s.booked_event_id IS DISTINCT FROM 'test-simulated-booking')
      OR s.exit_reason='booked'
      OR EXISTS(SELECT 1 FROM public.attendances a
        JOIN public.retention_candidates c ON c.sequence_id=s.id AND c.step=1
        WHERE a.club_id=s.club_id AND a.player_id=s.player_id AND a.event_id<>s.trigger_event_id
          AND (a.attended_at>(c.context->'trigger'->>'date')::timestamptz
            OR a.booked_at>(c.context->'trigger'->>'date')::timestamptz)) THEN
      RAISE EXCEPTION 'Player has booked; skip recovery and retain booked exit';
    END IF;
    PERFORM 1 FROM public.retention_candidates WHERE sequence_id=s.id FOR UPDATE;
    SELECT array_agg(DISTINCT message_id) INTO linked_ids FROM (
      SELECT message_id FROM public.retention_candidates WHERE sequence_id=s.id
      UNION SELECT s.step1_message_id UNION SELECT s.step2_message_id
    ) links WHERE message_id IS NOT NULL;
    PERFORM 1 FROM public.messages WHERE id=ANY(linked_ids) FOR UPDATE;
    destinations:=entry->'destinations';
    IF EXISTS(SELECT 1 FROM public.messages m WHERE m.id=ANY(linked_ids) AND m.status='sent'
      AND (m.retention_delivery_kind IS DISTINCT FROM 'test'
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(destinations) d
          WHERE d->>'message_id'=m.id::text AND d->>'twilio_message_sid'=m.twilio_message_sid
            AND d->>'to'='+12013702546'))) THEN
      RAISE EXCEPTION 'Non-test, changed, or unknown destination evidence; no recovery';
    END IF;
    SELECT to_jsonb(a) INTO current_report FROM public.playbook_outcomes_audit a
      WHERE a.sequence_id=s.id AND a.club_id=s.club_id;
    IF current_report IS NULL THEN RAISE EXCEPTION 'Audit snapshot unavailable'; END IF;
    INSERT INTO public.retention_test_history(club_id,player_id,sequence_id,original_step1_message_id,
      sequence_snapshot,candidates_snapshot,messages_snapshot,ledger_snapshot,test_control_snapshot,
      report_snapshot,message_destinations,reason,operator)
    VALUES(s.club_id,s.player_id,s.id,s.step1_message_id,to_jsonb(s),
      COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM public.retention_candidates c WHERE c.sequence_id=s.id),'[]'),
      COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM public.messages m WHERE m.id=ANY(linked_ids)),'[]'),
      COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM public.contact_ledger l WHERE l.club_id=s.club_id AND l.message_id=ANY(linked_ids)),'[]'),
      (SELECT to_jsonb(t) FROM public.retention_ltp_test_controls t WHERE t.sequence_id=s.id),
      current_report,destinations,'override-only test sends; no booking at reviewed recovery',actor);
    -- Existing promotion caps query player_id; these test rows are explicitly
    -- flagged and never represent real player contact. Preserve them, don't delete.
    UPDATE public.contact_ledger SET is_test=true,player_id=NULL
      WHERE club_id=s.club_id AND message_id=ANY(linked_ids);
    DELETE FROM public.retention_capacity_reservations WHERE sequence_id=s.id;
    DELETE FROM public.retention_ltp_test_controls WHERE sequence_id=s.id;
    DELETE FROM public.retention_candidates WHERE sequence_id=s.id;
    UPDATE public.retention_sequences SET step1_sent_at=NULL,step2_sent_at=NULL,
      step1_message_id=NULL,step2_message_id=NULL,step1_delivery_kind=NULL,
      sequence_status='active',exited_at=NULL,exit_reason=NULL,booked_event_id=NULL,updated_at=now()
      WHERE id=s.id;
    -- Players' last_outbound_at is intentionally untouched: it is null for all
    -- four audited players, and a concurrent real contact must never be cleared.
    RAISE LOG 'LTP test history archived/reset sequence=% operator=%',s.id,actor;
  END LOOP;
END $recovery$;

-- Preserve current report fields and append the archived report snapshots.
-- Historical rows are keyed by archive ID; original sequence_id stays in the
-- history table and full sequence snapshot. A reset live root is NOT is_test.
DO $view$
DECLARE definition text;
BEGIN
  definition:=pg_get_viewdef('public.playbook_outcomes_audit'::regclass,true);
  IF position('retention_test_history' IN definition)=0 THEN
    definition:=regexp_replace(definition,';\s*$','');
    EXECUTE format($sql$
      CREATE OR REPLACE VIEW public.playbook_outcomes_audit WITH (security_invoker=true) AS
      SELECT current_rows.* FROM (%s) current_rows
      UNION ALL
      SELECT historical.* FROM public.retention_test_history h
      CROSS JOIN LATERAL jsonb_populate_record(NULL::public.playbook_outcomes_audit,
        h.report_snapshot || jsonb_build_object('sequence_id',h.id,'is_test',true,'outcome',
          CASE WHEN (h.report_snapshot->>'booked')::boolean THEN 'booked'
            WHEN h.report_snapshot->>'step1_sent_at' IS NULL THEN 'not_started'
            WHEN now()<=(h.report_snapshot->>'window_closes_at')::timestamptz THEN 'in_window'
            ELSE 'no_booking' END)) historical
    $sql$,definition);
  END IF;
END $view$;
REVOKE ALL ON public.playbook_outcomes_audit FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.playbook_outcomes_audit TO service_role;
COMMIT;

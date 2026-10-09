-- WRITE-ONLY PROPOSAL. Do not apply without explicit authorization.
-- Leave uniqueness, conflict targets, and message rows completely untouched.
-- Compare-and-set and exact linked-message proof protect these four roots.
-- No draft/send RPC is called; no ledger or reporting-view changes are made.
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

-- Both statuses are TEXT with dedicated CHECK constraints in migration 013,
-- not enums. Preserve every existing value and all identity/uniqueness checks.
ALTER TABLE public.retention_sequences
  DROP CONSTRAINT IF EXISTS retention_sequences_sequence_status_check;
ALTER TABLE public.retention_sequences
  ADD CONSTRAINT retention_sequences_sequence_status_check CHECK (
    sequence_status IN ('active','paused_reply','exited_booked','exited_opt_out','completed','exited_test')
  );
ALTER TABLE public.retention_candidates
  DROP CONSTRAINT IF EXISTS retention_candidates_sequence_status_check;
ALTER TABLE public.retention_candidates
  ADD CONSTRAINT retention_candidates_sequence_status_check CHECK (
    sequence_status IN ('active','paused_reply','exited_booked','exited_opt_out','completed','exited_test')
  );

-- Existing transition RPCs do not know exited_test and could otherwise turn
-- it into exited_booked/completed. Protect the terminal state at the write
-- boundary without replacing RPCs or changing other sequences' behavior.
CREATE OR REPLACE FUNCTION public.retention_preserve_test_terminal_root()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.sequence_status='exited_test' AND (
    NEW.sequence_status IS DISTINCT FROM 'exited_test'
    OR NEW.exit_reason IS DISTINCT FROM 'test_override_sends'
    OR NEW.booked_event_id IS NOT NULL
    OR NEW.exited_at IS DISTINCT FROM OLD.exited_at
    OR ROW(NEW.club_id,NEW.player_id,NEW.playbook_key,NEW.trigger_event_id,
      NEW.step1_sent_at,NEW.step2_sent_at,NEW.step1_message_id,NEW.step2_message_id,NEW.step1_delivery_kind)
      IS DISTINCT FROM ROW(OLD.club_id,OLD.player_id,OLD.playbook_key,OLD.trigger_event_id,
      OLD.step1_sent_at,OLD.step2_sent_at,OLD.step1_message_id,OLD.step2_message_id,OLD.step1_delivery_kind)
  ) THEN
    RAISE EXCEPTION 'Override-test sequence is terminal; cannot reactivate or mark booked'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.retention_preserve_test_terminal_root() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS retention_preserve_test_terminal_root ON public.retention_sequences;
CREATE TRIGGER retention_preserve_test_terminal_root
  BEFORE UPDATE ON public.retention_sequences
  FOR EACH ROW EXECUTE FUNCTION public.retention_preserve_test_terminal_root();

CREATE OR REPLACE FUNCTION public.retention_preserve_test_terminal_candidate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.retention_sequences s WHERE s.id=NEW.sequence_id AND s.sequence_status='exited_test')
    AND (NEW.status IS DISTINCT FROM 'skipped' OR NEW.sequence_status IS DISTINCT FROM 'exited_test'
      OR NEW.exit_reason IS DISTINCT FROM 'test_override_sends' OR NEW.booked_event_id IS NOT NULL
      OR NEW.exited_at IS NULL
      OR COALESCE(NEW.context->'already_booked','false'::jsonb) IS DISTINCT FROM 'false'::jsonb
      OR COALESCE(NEW.context->'booked_event','null'::jsonb) IS DISTINCT FROM 'null'::jsonb) THEN
    RAISE EXCEPTION 'Override-test candidates cannot become dispatchable or booked'
      USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND OLD.sequence_status='exited_test'
    AND ROW(NEW.sequence_id,NEW.club_id,NEW.player_id,NEW.playbook_key,NEW.step,NEW.message_id,NEW.exited_at)
      IS DISTINCT FROM ROW(OLD.sequence_id,OLD.club_id,OLD.player_id,OLD.playbook_key,OLD.step,OLD.message_id,OLD.exited_at) THEN
    RAISE EXCEPTION 'Override-test candidate identity and closure are immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.retention_preserve_test_terminal_candidate() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS retention_preserve_test_terminal_candidate ON public.retention_candidates;
CREATE TRIGGER retention_preserve_test_terminal_candidate
  BEFORE INSERT OR UPDATE ON public.retention_candidates
  FOR EACH ROW EXECUTE FUNCTION public.retention_preserve_test_terminal_candidate();

-- The provider destinations below were independently fetched read-only.
-- Never infer them from is_test or from a player's current phone.
DO $recovery$
DECLARE s public.retention_sequences%ROWTYPE; entry jsonb; destinations jsonb;
  actor text:=session_user; current_report jsonb; linked_ids uuid[]; expected_ids uuid[];
  already_closed boolean;
BEGIN
  FOR entry IN SELECT value FROM jsonb_array_elements('[
    {"sequence_id":"965a9fdd-0184-4b70-a17a-1481458fc183","sequence_status":"active",
     "step1":"dc31720d-2f27-4fa8-a889-20ec95791b2f","step2":null,"booked_event_id":null,
     "destinations":[{"message_id":"dc31720d-2f27-4fa8-a889-20ec95791b2f","twilio_message_sid":"SM051963d7b82890ac49cacaef188902b2","to":"+12013702546"}]},
    {"sequence_id":"34f552a1-094d-401c-bfa6-e2a976c8393b","sequence_status":"active",
     "step1":"fca8dc6f-1333-4c1e-8cc0-bb9a70e196fc","step2":null,"booked_event_id":null,
     "destinations":[{"message_id":"fca8dc6f-1333-4c1e-8cc0-bb9a70e196fc","twilio_message_sid":"SMc950bc8f34fe7f9374e93a04f08e855e","to":"+12013702546"}]},
    {"sequence_id":"5ff2ab6a-4c12-4dae-aa56-634b89510659","sequence_status":"exited_booked",
     "step1":"36f60a30-5c02-433c-bbed-238077472b7f","step2":null,"booked_event_id":"test-simulated-booking",
     "unsent_message_ids":["ca8b9da4-d2ad-4e28-ace6-35d311c5ea5b"],
     "destinations":[{"message_id":"36f60a30-5c02-433c-bbed-238077472b7f","twilio_message_sid":"SM1166b95efd83680f36e6bd8019ee0271","to":"+12013702546"}]},
    {"sequence_id":"b755e667-19a8-4491-a849-4ae34127478d","sequence_status":"completed",
     "step1":"b4174321-c6a1-48b7-bed8-d81aeb72247f",
     "step2":"5005b574-d615-458b-b206-eaa155749f5f","booked_event_id":null,
     "destinations":[{"message_id":"b4174321-c6a1-48b7-bed8-d81aeb72247f","twilio_message_sid":"SMbacb212333ea47454d5152f521f83350","to":"+12013702546"},
       {"message_id":"5005b574-d615-458b-b206-eaa155749f5f","twilio_message_sid":"SM505fa95ee49e37789eeb12ca581da5f9","to":"+12013702546"}]}
  ]'::jsonb)
  LOOP
    SELECT * INTO s FROM public.retention_sequences WHERE id=(entry->>'sequence_id')::uuid
      AND club_id=(SELECT id FROM public.clubs WHERE slug='pb-club') AND playbook_key='ltp_followup' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recovery sequence not found'; END IF;
    already_closed:=s.sequence_status IS NOT DISTINCT FROM 'exited_test';
    IF s.step1_message_id IS DISTINCT FROM (entry->>'step1')::uuid
      OR s.step2_message_id IS DISTINCT FROM (entry->>'step2')::uuid
      OR s.step1_sent_at IS NULL OR s.step1_delivery_kind IS DISTINCT FROM 'test' THEN
      RAISE EXCEPTION 'Recovery identity or original test evidence changed';
    END IF;
    IF NOT already_closed AND (
      s.sequence_status IS DISTINCT FROM entry->>'sequence_status'
      OR s.booked_event_id IS DISTINCT FROM entry->>'booked_event_id'
    ) THEN
      RAISE EXCEPTION 'Recovery compare-and-set state changed for sequence %',s.id;
    END IF;
    PERFORM 1 FROM public.retention_candidates WHERE sequence_id=s.id FOR UPDATE;
    SELECT COALESCE(array_agg(DISTINCT message_id ORDER BY message_id),'{}'::uuid[]) INTO linked_ids FROM (
      SELECT message_id FROM public.retention_candidates WHERE sequence_id=s.id
      UNION SELECT s.step1_message_id UNION SELECT s.step2_message_id
    ) links WHERE message_id IS NOT NULL;
    PERFORM 1 FROM public.messages WHERE id=ANY(linked_ids) FOR UPDATE;
    destinations:=entry->'destinations';
    expected_ids:=ARRAY(
      SELECT (d->>'message_id')::uuid FROM jsonb_array_elements(destinations) d
      UNION SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(entry->'unsent_message_ids','[]'::jsonb))
      ORDER BY 1
    );
    IF linked_ids IS DISTINCT FROM expected_ids
      OR (SELECT count(*) FROM public.messages WHERE id=ANY(linked_ids))<>cardinality(expected_ids) THEN
      RAISE EXCEPTION 'Recovery linked-message set changed: missing or extra message for sequence %',s.id;
    END IF;
    -- The listed SID-to-destination bindings are independently fetched provider
    -- proof, not a local is_test flag or inferred current player phone.
    IF EXISTS(SELECT 1 FROM public.messages m WHERE m.id=ANY(linked_ids)
      AND (m.twilio_message_sid IS NOT NULL OR m.sent_at IS NOT NULL
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(destinations) d WHERE d->>'message_id'=m.id::text))
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(destinations) d
          WHERE d->>'message_id'=m.id::text AND d->>'twilio_message_sid'=m.twilio_message_sid
            AND d->>'to'='+12013702546')) THEN
      RAISE EXCEPTION 'Recovery destination proof changed or missing for sequence %',s.id;
    END IF;
    IF already_closed THEN
      IF s.exit_reason IS DISTINCT FROM 'test_override_sends' OR s.exited_at IS NULL OR s.booked_event_id IS NOT NULL
        OR NOT EXISTS(SELECT 1 FROM public.retention_test_history
          WHERE sequence_id=s.id AND original_step1_message_id=(entry->>'step1')::uuid)
        OR EXISTS(SELECT 1 FROM public.retention_candidates c WHERE c.sequence_id=s.id
          AND (c.sequence_status IS DISTINCT FROM 'exited_test' OR c.status IS DISTINCT FROM 'skipped'
            OR c.exit_reason IS DISTINCT FROM 'test_override_sends' OR c.booked_event_id IS NOT NULL
            OR c.exited_at IS DISTINCT FROM s.exited_at
            OR c.context->'already_booked' IS DISTINCT FROM 'false'::jsonb
            OR c.context->'booked_event' IS DISTINCT FROM 'null'::jsonb
            OR c.context->>'reason' IS DISTINCT FROM 'test_override_sends'))
        OR EXISTS(SELECT 1 FROM public.retention_capacity_reservations WHERE sequence_id=s.id)
        OR EXISTS(SELECT 1 FROM public.retention_ltp_test_controls WHERE sequence_id=s.id) THEN
        RAISE EXCEPTION 'Recovery terminal closure is incomplete for sequence %',s.id;
      END IF;
      CONTINUE;
    END IF;
    SELECT to_jsonb(a) INTO STRICT current_report FROM public.playbook_outcomes_audit a
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
    DELETE FROM public.retention_capacity_reservations WHERE sequence_id=s.id;
    DELETE FROM public.retention_ltp_test_controls WHERE sequence_id=s.id;
    -- Preserve actual send times/links/kind: they are immutable test evidence
    -- and keep the unchanged live outcomes view's is_test classification true.
    UPDATE public.retention_sequences SET sequence_status='exited_test',
      exited_at=now(),exit_reason='test_override_sends',booked_event_id=NULL,updated_at=now()
      WHERE id=s.id;
    UPDATE public.retention_candidates SET status='skipped',sequence_status='exited_test',
      exited_at=now(),exit_reason='test_override_sends',booked_event_id=NULL,
      context=COALESCE(context,'{}'::jsonb) || jsonb_build_object(
        'already_booked',false,'booked_event',NULL,'reason','test_override_sends'),updated_at=now()
      WHERE sequence_id=s.id;
    -- Players' last_outbound_at is intentionally untouched: it is null for all
    -- four audited players, and a concurrent real contact must never be cleared.
    RAISE LOG 'LTP test history archived/closed sequence=% operator=%',s.id,actor;
  END LOOP;
END $recovery$;

COMMIT;

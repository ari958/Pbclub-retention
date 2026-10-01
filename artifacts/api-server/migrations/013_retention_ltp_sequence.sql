-- Additive, draft-only two-step LTP sequences.
-- Run this file MANUALLY in the existing Supabase project's SQL Editor.
-- Never run it against Replit DATABASE_URL or from application code.
--
-- Backfill establishes step-1 identity and sequence roots without changing
-- candidate/message text, approvals, schedules, send states, or club settings.
BEGIN;

ALTER TABLE public.retention_playbooks
  ADD COLUMN IF NOT EXISTS ltp_sequence_config jsonb;
ALTER TABLE public.retention_candidates
  ADD COLUMN IF NOT EXISTS step smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sequence_id uuid,
  ADD COLUMN IF NOT EXISTS sequence_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS exited_at timestamptz,
  ADD COLUMN IF NOT EXISTS exit_reason text,
  ADD COLUMN IF NOT EXISTS booked_event_id text;
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS retention_delivery_kind text;

-- NULL deliberately remains the value for historical/non-sequence messages:
-- only a positively identified real recipient delivery may start step 2.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.messages'::regclass
      AND conname='messages_retention_delivery_kind_check'
  ) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_retention_delivery_kind_check
      CHECK (retention_delivery_kind IS NULL OR
        retention_delivery_kind IN ('real','test','simulated'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.retention_candidates'::regclass
      AND conname='retention_candidates_step_check'
  ) THEN
    ALTER TABLE public.retention_candidates
      ADD CONSTRAINT retention_candidates_step_check CHECK (step IN (1,2));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.retention_candidates'::regclass
      AND conname='retention_candidates_sequence_status_check'
  ) THEN
    ALTER TABLE public.retention_candidates
      ADD CONSTRAINT retention_candidates_sequence_status_check CHECK (
        sequence_status IN ('active','paused_reply','exited_booked','exited_opt_out','completed')
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.retention_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  player_id uuid NOT NULL REFERENCES public.players(id),
  playbook_key text NOT NULL REFERENCES public.retention_playbooks(key),
  trigger_event_id text NOT NULL,
  sequence_status text NOT NULL DEFAULT 'active'
    CHECK (sequence_status IN ('active','paused_reply','exited_booked','exited_opt_out','completed')),
  exited_at timestamptz,
  exit_reason text,
  booked_event_id text,
  step1_sent_at timestamptz,
  step1_message_id uuid REFERENCES public.messages(id),
  step1_delivery_kind text CHECK (step1_delivery_kind IS NULL OR step1_delivery_kind IN ('real','test','simulated')),
  step2_sent_at timestamptz,
  step2_message_id uuid REFERENCES public.messages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id,player_id,playbook_key)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.retention_candidates'::regclass
      AND conname='retention_candidates_sequence_fk') THEN
    ALTER TABLE public.retention_candidates ADD CONSTRAINT retention_candidates_sequence_fk
      FOREIGN KEY(sequence_id) REFERENCES public.retention_sequences(id);
  END IF;
END $$;
ALTER TABLE public.retention_sequences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.retention_sequences FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.retention_sequences TO service_role;

-- Do not rely on CREATE IF NOT EXISTS to make an existing lock table secure.
CREATE TABLE IF NOT EXISTS public.retention_capacity_event_locks (
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(club_id,event_id)
);
CREATE TABLE IF NOT EXISTS public.retention_capacity_reservations (
  candidate_id uuid PRIMARY KEY REFERENCES public.retention_candidates(id) ON DELETE CASCADE,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  sequence_id uuid NOT NULL REFERENCES public.retention_sequences(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  open_spots integer NOT NULL CHECK (open_spots > 0),
  event_start_time timestamptz NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retention_capacity_event_idx
  ON public.retention_capacity_reservations(club_id,event_id);
CREATE INDEX IF NOT EXISTS retention_sequence_due_idx
  ON public.retention_sequences(club_id,sequence_status,step1_sent_at)
  WHERE step1_sent_at IS NOT NULL;
ALTER TABLE public.retention_capacity_event_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_capacity_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.retention_capacity_event_locks, public.retention_capacity_reservations
  FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.retention_capacity_event_locks, public.retention_capacity_reservations
  TO service_role;

-- Preserve an unusual non-LTP unique index/constraint if an operator added one;
-- remove only a UNIQUE constraint over exactly (player_id,playbook_key).
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN LATERAL (
      SELECT array_agg(att.attname ORDER BY key.ordinality) AS names
      FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum,ordinality)
      JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum=key.attnum
    ) cols ON true
    WHERE con.conrelid='public.retention_candidates'::regclass
      AND con.contype='u'
      AND cols.names=ARRAY['player_id','playbook_key']::name[]
  LOOP
    EXECUTE format('ALTER TABLE public.retention_candidates DROP CONSTRAINT %I',constraint_name);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS retention_candidates_player_playbook_step_unique
  ON public.retention_candidates(player_id,playbook_key,step);
CREATE UNIQUE INDEX IF NOT EXISTS retention_candidates_sequence_step_unique
  ON public.retention_candidates(sequence_id,step) WHERE sequence_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS retention_candidates_sequence_status_idx
  ON public.retention_candidates(sequence_id,sequence_status,step);

-- Existing rows are step 1 by the additive default. Only LTP rows receive a
-- sequence root; nothing in the original review or message is edited.
INSERT INTO public.retention_sequences(club_id,player_id,playbook_key,trigger_event_id)
SELECT DISTINCT ON (c.club_id,c.player_id,c.playbook_key)
  c.club_id,c.player_id,c.playbook_key,c.trigger_event_id
FROM public.retention_candidates c
WHERE c.playbook_key='ltp_followup'
ORDER BY c.club_id,c.player_id,c.playbook_key,c.created_at,c.id
ON CONFLICT(club_id,player_id,playbook_key) DO NOTHING;
UPDATE public.retention_candidates c
SET sequence_id=s.id
FROM public.retention_sequences s
WHERE c.playbook_key='ltp_followup' AND c.sequence_id IS NULL
  AND s.club_id=c.club_id AND s.player_id=c.player_id AND s.playbook_key=c.playbook_key;
UPDATE public.retention_candidates c
SET sequence_status=s.sequence_status,exited_at=s.exited_at,
    exit_reason=s.exit_reason,booked_event_id=s.booked_event_id
FROM public.retention_sequences s
WHERE c.sequence_id=s.id AND (
  c.sequence_status IS DISTINCT FROM s.sequence_status
  OR c.exited_at IS DISTINCT FROM s.exited_at
  OR c.exit_reason IS DISTINCT FROM s.exit_reason
  OR c.booked_event_id IS DISTINCT FROM s.booked_event_id
);

-- Preserve preexisting event assignments until the event starts. The historical
-- open-spots value is retained as a fact; malformed/incomplete old contexts are
-- not guessed into a reservation and must be rebuilt before approval.
INSERT INTO public.retention_capacity_reservations(
  candidate_id,club_id,sequence_id,event_id,open_spots,event_start_time
)
SELECT c.id,c.club_id,c.sequence_id,c.context->'next_program'->>'event_id',
       (c.context->'next_program'->>'spots_remaining')::integer,
       (c.context->'next_program'->>'start_time')::timestamptz
FROM public.retention_candidates c
WHERE c.playbook_key='ltp_followup' AND c.sequence_id IS NOT NULL
  AND c.status IN ('drafted','manual_edit','approved','sent')
  AND jsonb_typeof(c.context->'next_program')='object'
  AND NULLIF(c.context->'next_program'->>'event_id','') IS NOT NULL
  AND COALESCE(c.context->'next_program'->>'spots_remaining','') ~ '^[1-9][0-9]*$'
  AND COALESCE(c.context->'next_program'->>'start_time','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
  AND (c.context->'next_program'->>'start_time')::timestamptz>now()
ON CONFLICT(candidate_id) DO NOTHING;

-- Never assume that a historical "sent" row means real delivery. Exclude
-- redirected tests and simulations; only a non-test contact-ledger record with
-- an actual, nonsimulated recipient message proves a prior real delivery.
UPDATE public.messages m SET retention_delivery_kind =
  CASE WHEN m.simulated IS TRUE THEN 'simulated'
       WHEN EXISTS (
         SELECT 1 FROM public.contact_ledger l
         WHERE l.message_id=m.id AND l.is_test IS TRUE
       ) THEN 'test'
        WHEN m.status='sent' AND m.sent_at IS NOT NULL AND m.simulated IS FALSE
          AND m.delivery_status='delivered' AND m.delivered_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM public.contact_ledger l
           WHERE l.message_id=m.id AND l.is_test IS FALSE
             AND (l.player_id=m.player_id OR l.intended_player_id=m.player_id)
         ) THEN 'real'
       ELSE NULL END
WHERE m.retention_delivery_kind IS NULL
  AND EXISTS(SELECT 1 FROM public.retention_candidates c WHERE c.message_id=m.id AND c.playbook_key='ltp_followup');
UPDATE public.retention_sequences s
SET step1_message_id=c.message_id,
    step1_sent_at=m.sent_at,
    step1_delivery_kind=m.retention_delivery_kind
FROM public.retention_candidates c
JOIN public.messages m ON m.id=c.message_id
WHERE c.sequence_id=s.id AND c.step=1 AND c.playbook_key='ltp_followup'
  AND m.sent_at IS NOT NULL AND m.retention_delivery_kind IN ('real','test','simulated')
  AND s.step1_sent_at IS NULL;
UPDATE public.retention_sequences s
SET step2_message_id=c.message_id,step2_sent_at=m.sent_at
FROM public.retention_candidates c
JOIN public.messages m ON m.id=c.message_id
WHERE c.sequence_id=s.id AND c.step=2 AND c.playbook_key='ltp_followup'
  AND m.sent_at IS NOT NULL AND m.retention_delivery_kind IN ('real','test','simulated')
  AND s.step2_sent_at IS NULL;
UPDATE public.retention_sequences SET sequence_status='completed',updated_at=now()
WHERE step2_sent_at IS NOT NULL AND step1_delivery_kind='real' AND sequence_status='active';
UPDATE public.retention_candidates c
SET sequence_status=s.sequence_status,exited_at=s.exited_at,exit_reason=s.exit_reason,booked_event_id=s.booked_event_id
FROM public.retention_sequences s WHERE c.sequence_id=s.id;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.retention_candidates'::regclass
      AND conname='retention_candidates_ltp_sequence_identity_check') THEN
    ALTER TABLE public.retention_candidates
      ADD CONSTRAINT retention_candidates_ltp_sequence_identity_check CHECK (
        (playbook_key='ltp_followup' AND sequence_id IS NOT NULL)
        OR (playbook_key<>'ltp_followup' AND step=1 AND sequence_id IS NULL AND sequence_status='active'
            AND exited_at IS NULL AND exit_reason IS NULL AND booked_event_id IS NULL)
      );
  END IF;
END $$;

-- Templates are editable facts of the LTP playbook, not code-deployed prose.
-- Keeping both steps separate prevents an accidental step-1 offer in step 2.
UPDATE public.retention_playbooks
SET ltp_sequence_config='{
  "step2_gap_days":7,
  "step1":{
    "opener":["Hi {first}, it''s PB Club."],
    "thanks":[
      "Thanks for coming to Learn to Play on {ltp_date}.",
      "Great having you at Learn to Play on {ltp_date}.",
      "Glad you made it to Learn to Play on {ltp_date}.",
      "Hope you enjoyed Learn to Play on {ltp_date}."
    ],
    "next_step":[
      "A good next step is {program} on {when}.",
      "If you''re ready for more, {program} is on {when}.",
      "{program} on {when} is a natural next step.",
      "Next up for a lot of new players: {program} on {when}."
    ],
    "offer":[
      "Use code {promo} for 25% off:",
      "Here''s 25% off with code {promo}:",
      "Code {promo} takes 25% off:"
    ],
    "offer_no_program":[
      "Use code {promo} for 25% off your next program:",
      "Here''s 25% off your next program with code {promo}:"
    ]
  },
  "step2":{
    "opener":["Hi {first}, it''s PB Club.","Hey {first}, PB Club here."],
    "nudge":[
      "Hope you''re ready to get back out there.",
      "We''d love to see you back on the court.",
      "Thinking about your next session?"
    ],
    "next_step":[
      "{program} on {when} still has spots.",
      "{program} on {when} is a great fit after Learn to Play.",
      "There''s room in {program} on {when}."
    ],
    "no_program_cta":["Here''s what''s coming up:"]
  }
}'::jsonb
WHERE key='ltp_followup';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.retention_playbooks'::regclass
      AND conname='retention_playbooks_ltp_sequence_gap_check') THEN
    ALTER TABLE public.retention_playbooks
      ADD CONSTRAINT retention_playbooks_ltp_sequence_gap_check CHECK (
        key<>'ltp_followup' OR (
          jsonb_typeof(ltp_sequence_config->'step2_gap_days')='number'
          AND (ltp_sequence_config->>'step2_gap_days')::numeric BETWEEN 7 AND 30
          AND trunc((ltp_sequence_config->>'step2_gap_days')::numeric)
            =(ltp_sequence_config->>'step2_gap_days')::numeric
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.retention_playbooks WHERE key='ltp_followup') THEN
    RAISE EXCEPTION 'The existing ltp_followup playbook must exist before applying migration 013';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.retention_candidates
    WHERE playbook_key='ltp_followup' AND sequence_id IS NULL
  ) THEN RAISE EXCEPTION 'Could not backfill all LTP retention sequence roots'; END IF;
END $$;

-- Keep the tested 011/012 implementations intact under private legacy names.
-- Every existing PostgREST entry point below is replaced with a guarded wrapper.
ALTER FUNCTION public.retention_create_candidate(uuid,uuid,text,text,jsonb,text,text)
  RENAME TO retention_create_candidate_legacy;
ALTER FUNCTION public.retention_create_draft(uuid,uuid,text,text,jsonb,text)
  RENAME TO retention_create_draft_legacy;
ALTER FUNCTION public.retention_regenerate_draft(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text)
  RENAME TO retention_regenerate_draft_legacy;
ALTER FUNCTION public.retention_manual_edit_candidate(uuid,uuid,text,text,jsonb,timestamptz)
  RENAME TO retention_manual_edit_candidate_legacy;
ALTER FUNCTION public.retention_update_candidate(uuid,uuid,text,text,text,timestamptz)
  RENAME TO retention_update_candidate_legacy;
ALTER FUNCTION public.retention_retry_context(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text,uuid)
  RENAME TO retention_retry_context_legacy;

CREATE OR REPLACE FUNCTION public.retention_create_candidate(
  p_club_id uuid,p_player_id uuid,p_playbook_key text,p_trigger_event_id text,
  p_context jsonb,p_status text,p_body text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_msg_id uuid;
BEGIN
  IF p_playbook_key='ltp_followup' THEN
    RAISE EXCEPTION 'Use retention_sequence_save_batch for LTP step 1 and step 2';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.players WHERE id=p_player_id AND club_id=p_club_id) THEN
    RAISE EXCEPTION 'Player does not belong to club';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.retention_playbooks WHERE key=p_playbook_key AND enabled) THEN
    RAISE EXCEPTION 'Playbook is not enabled';
  END IF;
  IF p_context IS NULL OR jsonb_typeof(p_context)<>'object' THEN
    RAISE EXCEPTION 'Candidate context must be a JSON object';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('drafted','needs_context','manual_edit','skipped') THEN
    RAISE EXCEPTION 'Unsupported retention candidate status';
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
  INSERT INTO public.retention_candidates(club_id,player_id,playbook_key,trigger_event_id,context,status)
  VALUES(p_club_id,p_player_id,p_playbook_key,p_trigger_event_id,p_context,p_status)
  ON CONFLICT(player_id,playbook_key,step) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  IF p_status='drafted' THEN
    INSERT INTO public.messages(player_id,body,direction,sent_by,status)
    VALUES(p_player_id,btrim(p_body),'outbound','agent','pending')
    RETURNING id INTO v_msg_id;
    UPDATE public.retention_candidates SET message_id=v_msg_id WHERE id=v_id;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.retention_create_draft(
  p_club_id uuid,p_player_id uuid,p_playbook_key text,p_trigger_event_id text,
  p_context jsonb,p_body text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_playbook_key='ltp_followup' THEN
    RAISE EXCEPTION 'Use retention_sequence_save_batch for LTP step 1 and step 2';
  END IF;
  RETURN public.retention_create_candidate(p_club_id,p_player_id,p_playbook_key,p_trigger_event_id,p_context,'drafted',p_body);
END $$;

CREATE OR REPLACE FUNCTION public.retention_regenerate_draft(
  p_id uuid,p_club_id uuid,p_expected_body text,p_expected_context jsonb,
  p_expected_updated_at timestamptz,p_new_body text,p_new_context jsonb,
  p_new_status text,p_error text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_key text; r jsonb;
BEGIN
  SELECT playbook_key INTO v_key FROM public.retention_candidates
    WHERE id=p_id AND club_id=p_club_id;
  IF v_key='ltp_followup' THEN
    RAISE EXCEPTION 'Use retention_sequence_save_batch for LTP regenerate and reshuffle';
  END IF;
  SELECT public.retention_regenerate_draft_legacy(
    p_id,p_club_id,p_expected_body,p_expected_context,p_expected_updated_at,
    p_new_body,p_new_context,p_new_status,p_error
  ) INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.retention_manual_edit_candidate(
  p_id uuid,p_club_id uuid,p_body text,p_expected_body text,
  p_expected_context jsonb,p_expected_updated_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_key text; v_seq uuid; c public.retention_candidates%ROWTYPE; r jsonb;
BEGIN
  SELECT playbook_key,sequence_id INTO v_key,v_seq
  FROM public.retention_candidates WHERE id=p_id AND club_id=p_club_id;
  IF v_key='ltp_followup' THEN
    PERFORM 1 FROM public.retention_sequences WHERE id=v_seq FOR UPDATE;
    SELECT * INTO c FROM public.retention_candidates WHERE id=p_id AND club_id=p_club_id FOR UPDATE;
    IF c.sequence_status<>'active' OR c.sequence_id IS NULL
       OR (c.context->'ltp_text'->>'step') !~ '^[12]$'
       OR (c.context->'ltp_text'->>'step')::smallint IS DISTINCT FROM c.step THEN
      RAISE EXCEPTION 'Rebuild this LTP draft before manual text editing';
    END IF;
    IF EXISTS(SELECT 1 FROM public.messages m WHERE m.id=c.message_id AND
       (m.status IS DISTINCT FROM 'pending' OR m.approved_at IS NOT NULL OR
        m.approved_by IS NOT NULL OR m.approved_body IS NOT NULL OR
        m.scheduled_send_at IS NOT NULL OR m.sent_at IS NOT NULL OR m.dispatch_claimed_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'LTP message is approved, scheduled, sent, or claimed';
    END IF;
    SELECT public.retention_manual_edit_candidate_legacy(
      p_id,p_club_id,p_body,p_expected_body,p_expected_context,p_expected_updated_at
    ) INTO r;
    RETURN r;
  END IF;
  RETURN public.retention_manual_edit_candidate_legacy(
    p_id,p_club_id,p_body,p_expected_body,p_expected_context,p_expected_updated_at
  );
END $$;

CREATE OR REPLACE FUNCTION public.retention_retry_context(
  p_id uuid,p_club_id uuid,p_expected_body text,p_expected_context jsonb,
  p_expected_updated_at timestamptz,p_new_body text,p_new_context jsonb,
  p_new_status text,p_error text DEFAULT NULL,p_expected_message_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_key text; r jsonb;
BEGIN
  SELECT playbook_key INTO v_key FROM public.retention_candidates
    WHERE id=p_id AND club_id=p_club_id;
  IF v_key='ltp_followup' THEN
    RAISE EXCEPTION 'Use retention_sequence_save_batch for LTP context retry';
  END IF;
  SELECT public.retention_retry_context_legacy(
    p_id,p_club_id,p_expected_body,p_expected_context,p_expected_updated_at,
    p_new_body,p_new_context,p_new_status,p_error,p_expected_message_id
  ) INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.retention_ltp_has_attendance_since(
  p_player_id uuid,p_cutoff timestamptz,p_exclude_event_id text DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.attendances a
    WHERE a.player_id=p_player_id
      AND a.attended_at>=p_cutoff
      AND (p_exclude_event_id IS NULL OR a.event_id::text IS DISTINCT FROM p_exclude_event_id)
  )
$$;

CREATE OR REPLACE FUNCTION public.retention_sequence_transition(
  p_club_id uuid,p_player_id uuid,p_playbook_key text,p_status text,
  p_reason text,p_booked_event_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.retention_sequences%ROWTYPE; next_status text; next_reason text; next_booked text;
BEGIN
  IF p_playbook_key IS DISTINCT FROM 'ltp_followup'
     OR p_status IS NULL
     OR p_status NOT IN ('paused_reply','exited_booked','exited_opt_out','completed') THEN
    RAISE EXCEPTION 'Unsupported LTP sequence transition';
  END IF;
  SELECT * INTO s FROM public.retention_sequences
  WHERE club_id=p_club_id AND player_id=p_player_id AND playbook_key=p_playbook_key
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LTP sequence not found'; END IF;
  IF p_status='exited_booked' AND NULLIF(btrim(p_booked_event_id),'') IS NULL THEN
    RAISE EXCEPTION 'A booked event ID is required';
  END IF;
  IF p_status='completed' AND NOT EXISTS(
    SELECT 1 FROM public.messages m WHERE m.id=s.step2_message_id
      AND m.sent_at IS NOT NULL AND m.retention_delivery_kind='real'
  ) THEN RAISE EXCEPTION 'Only a real step-2 delivery can complete a sequence'; END IF;

  -- Opt-out is permanent and outranks every transition. A later confirmed
  -- booking also supersedes an ordinary reply pause; neither can revive a
  -- completed or opted-out sequence.
  next_status:=s.sequence_status;
  next_reason:=s.exit_reason;
  next_booked:=s.booked_event_id;
  IF s.sequence_status='exited_opt_out' THEN
    NULL;
  ELSIF p_status='exited_opt_out' THEN
    next_status:='exited_opt_out'; next_reason=COALESCE(NULLIF(btrim(p_reason),''),'stop_opt_out');
  ELSIF s.sequence_status='completed' THEN
    NULL;
  ELSIF p_status='exited_booked' THEN
    next_status:='exited_booked'; next_reason=COALESCE(NULLIF(btrim(p_reason),''),'player_booked');
    next_booked:=p_booked_event_id;
  ELSIF s.sequence_status='exited_booked' THEN
    NULL;
  ELSIF p_status='paused_reply' AND s.sequence_status='active' THEN
    next_status:='paused_reply'; next_reason=COALESCE(NULLIF(btrim(p_reason),''),'player_reply');
  ELSIF p_status='completed' THEN
    next_status:='completed'; next_reason=COALESCE(NULLIF(btrim(p_reason),''),'step2_sent');
  END IF;

  UPDATE public.retention_sequences
  SET sequence_status=next_status,exit_reason=next_reason,booked_event_id=next_booked,
      exited_at=CASE WHEN next_status IN ('exited_booked','exited_opt_out') THEN COALESCE(exited_at,now()) ELSE exited_at END,
      updated_at=now()
  WHERE id=s.id RETURNING * INTO s;
  UPDATE public.retention_candidates c
  SET sequence_status=s.sequence_status,exited_at=s.exited_at,
      exit_reason=s.exit_reason,booked_event_id=s.booked_event_id,updated_at=now()
  WHERE c.sequence_id=s.id;

  IF s.sequence_status IN ('paused_reply','exited_booked','exited_opt_out') THEN
    -- Stop all not-yet-claimed messages in this sequence, including a step-1
    -- message discovered booked/replied before it is dispatched. Do not mutate
    -- in-flight/sent rows or erase their operator-approval audit evidence.
    UPDATE public.messages m
    SET status='skipped',error_message='LTP sequence stopped: '||s.sequence_status
    FROM public.retention_candidates c
    WHERE c.sequence_id=s.id AND c.message_id=m.id
      AND m.status='pending' AND m.dispatch_claimed_at IS NULL
      AND (c.step=1 OR c.step=2)
      AND c.status NOT IN ('sent','skipped');
    UPDATE public.retention_candidates c
    SET status='skipped',
        context=c.context||jsonb_build_object('reason',s.sequence_status)
    WHERE c.sequence_id=s.id AND c.message_id IN(
      SELECT m.id FROM public.messages m WHERE m.status='skipped'
        AND m.error_message='LTP sequence stopped: '||s.sequence_status
    ) AND c.status NOT IN ('sent','skipped');
    DELETE FROM public.retention_capacity_reservations WHERE sequence_id=s.id;
  END IF;
  RETURN to_jsonb(s);
END $$;

CREATE OR REPLACE FUNCTION public.retention_sequence_player_optout_changed()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_root record;
BEGIN
  IF NEW.opted_out IS TRUE AND OLD.opted_out IS DISTINCT FROM TRUE THEN
    -- Player rows are locked by the UPDATE statement before this trigger runs.
    -- Batch-save and dispatch claim take the same player-before-root lock order.
    FOR v_root IN
      SELECT s.club_id,s.player_id
      FROM public.retention_sequences s
      WHERE s.club_id=NEW.club_id AND s.player_id=NEW.id
        AND s.playbook_key='ltp_followup'
      ORDER BY s.id
    LOOP
      PERFORM public.retention_sequence_transition(
        v_root.club_id,v_root.player_id,'ltp_followup','exited_opt_out','player_opted_out',NULL
      );
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.retention_sequence_player_optout_changed()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.retention_sequence_player_optout_changed() TO service_role;

DO $$
DECLARE v_trigger pg_trigger%ROWTYPE;
BEGIN
  SELECT * INTO v_trigger FROM pg_trigger
  WHERE tgrelid='public.players'::regclass
    AND tgname='players_ltp_retention_optout'
    AND NOT tgisinternal;
  IF NOT FOUND THEN
    EXECUTE 'CREATE TRIGGER players_ltp_retention_optout
      AFTER UPDATE OF opted_out ON public.players
      FOR EACH ROW
      WHEN (NEW.opted_out IS TRUE AND OLD.opted_out IS DISTINCT FROM TRUE)
      EXECUTE FUNCTION public.retention_sequence_player_optout_changed()';
  ELSIF v_trigger.tgfoid IS DISTINCT FROM
        'public.retention_sequence_player_optout_changed()'::regprocedure
     OR v_trigger.tgenabled<>'O'
     OR (v_trigger.tgtype & 17)<>17
     OR (v_trigger.tgtype & 2)=2 THEN
    RAISE EXCEPTION 'Existing players_ltp_retention_optout trigger is not an enabled AFTER ROW UPDATE trigger for LTP opt-out';
  END IF;
END $$;

-- Normalize opt-outs which predate this migration after the transition helper
-- exists. The trigger is installed first so concurrent flag writes cannot miss
-- both the backfill and the future callback path.
DO $$
DECLARE v_root record;
BEGIN
  FOR v_root IN
    SELECT s.club_id,s.player_id
    FROM public.retention_sequences s
    JOIN public.players p ON p.id=s.player_id AND p.club_id=s.club_id
    WHERE s.playbook_key='ltp_followup' AND p.opted_out IS TRUE
      AND s.sequence_status IS DISTINCT FROM 'exited_opt_out'
    ORDER BY s.id
  LOOP
    PERFORM public.retention_sequence_transition(
      v_root.club_id,v_root.player_id,'ltp_followup','exited_opt_out','player_opted_out',NULL
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.retention_sequence_session_changed(
  p_club_id uuid,p_candidate_id uuid,p_expected_claimed_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.retention_candidates%ROWTYPE; s public.retention_sequences%ROWTYPE;
        m public.messages%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.retention_candidates
  WHERE id=p_candidate_id AND club_id=p_club_id;
  IF NOT FOUND OR c.playbook_key IS DISTINCT FROM 'ltp_followup' THEN
    RAISE EXCEPTION 'LTP candidate not found';
  END IF;
  SELECT * INTO s FROM public.retention_sequences WHERE id=c.sequence_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LTP sequence not found'; END IF;
  SELECT * INTO c FROM public.retention_candidates
  WHERE id=p_candidate_id AND club_id=p_club_id FOR UPDATE;
  IF c.status NOT IN ('approved','drafted') THEN
    RAISE EXCEPTION 'Only an active step draft can be returned for session review';
  END IF;
  IF c.sequence_status<>'active' OR c.context->'ltp_text'->>'step'<>c.step::text THEN
    RAISE EXCEPTION 'Only a rebuilt active LTP draft can be returned for review';
  END IF;
  IF c.message_id IS NULL THEN RAISE EXCEPTION 'LTP draft message is missing'; END IF;
  SELECT * INTO m FROM public.messages WHERE id=c.message_id FOR UPDATE;
  IF NOT FOUND OR m.dispatch_claimed_at IS DISTINCT FROM p_expected_claimed_at THEN
    RAISE EXCEPTION 'Message claim changed since session verification';
  END IF;
  IF m.status NOT IN ('pending','sending') OR
     (m.dispatch_claimed_at IS NOT NULL AND m.dispatch_claimed_at IS DISTINCT FROM p_expected_claimed_at) THEN
    RAISE EXCEPTION 'Message is sent or concurrently claimed';
  END IF;
  UPDATE public.messages
  SET status='pending',approved_at=NULL,approved_by=NULL,approved_body=NULL,
      scheduled_send_at=NULL,dispatch_claimed_at=NULL,dispatch_token=NULL,
      retention_delivery_kind=NULL,
      error_message='Session changed after draft: operator review required'
  WHERE id=m.id;
  UPDATE public.retention_candidates SET status='drafted',
    context=(context-'ltp_text')||jsonb_build_object(
      'reason','session_changed','errors',jsonb_build_array('Suggested session changed; rebuild context and re-review'),
      'validation_errors','[]'::jsonb
    ),updated_at=now() WHERE id=c.id RETURNING * INTO c;
  DELETE FROM public.retention_capacity_reservations WHERE candidate_id=c.id;
  RETURN to_jsonb(c)||jsonb_build_object('body',(SELECT body FROM public.messages WHERE id=c.message_id));
END $$;

CREATE OR REPLACE FUNCTION public.retention_sequence_due_step2(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE results jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(
    to_jsonb(c)||jsonb_build_object(
      'body',m.body,'step1_text',COALESCE(m.approved_body,m.body),
      'step1_sent_at',s.step1_sent_at,'step1_message_id',s.step1_message_id,
      'step1_delivery_kind',s.step1_delivery_kind,
      'ltp_sequence_config',p.ltp_sequence_config
    ) ORDER BY s.step1_sent_at,c.id
  ),'[]'::jsonb) INTO results
  FROM public.retention_sequences s
  JOIN public.retention_playbooks p ON p.key=s.playbook_key AND p.enabled
  JOIN public.retention_candidates c ON c.sequence_id=s.id AND c.step=1
  JOIN public.messages m ON m.id=s.step1_message_id
  JOIN public.players pl ON pl.id=c.player_id AND pl.club_id=c.club_id
  WHERE s.club_id=p_club_id AND s.playbook_key='ltp_followup'
    AND s.sequence_status='active' AND s.step1_delivery_kind='real'
    AND pl.opted_out IS NOT TRUE
    AND s.step1_sent_at IS NOT NULL
    AND now()-s.step1_sent_at>=make_interval(days=>(p.ltp_sequence_config->>'step2_gap_days')::integer)
    AND c.status='sent' AND m.status='sent' AND m.sent_at IS NOT NULL
    AND m.retention_delivery_kind='real'
    AND NOT public.retention_ltp_has_attendance_since(c.player_id,s.step1_sent_at)
    AND NOT EXISTS(SELECT 1 FROM public.retention_candidates c2 WHERE c2.sequence_id=s.id AND c2.step=2);
  RETURN results;
END $$;

-- Transactional create/regenerate/reshuffle: the application performs all live
-- lookups and text validation first, then submits ONE ordered CAS batch. Root
-- sequences are locked before candidates, messages, and sorted capacity events.
CREATE OR REPLACE FUNCTION public.retention_sequence_save_batch(
  p_club_id uuid,p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_item jsonb;
  v_saved jsonb:='[]'::jsonb;
  v_created_ids uuid[]:='{}'::uuid[];
  v_sequence_id uuid;
  v_message_id uuid;
  v_open integer;
  v_outside integer;
  v_step smallint;
  v_operation text;
  v_status text;
  v_candidate public.retention_candidates%ROWTYPE;
  v_message public.messages%ROWTYPE;
  v_sequence public.retention_sequences%ROWTYPE;
  v_context jsonb;
  v_player_id uuid;
  v_candidate_id uuid;
  v_event_id text;
  v_event_time timestamptz;
  v_trigger_date date;
  v_ltp_text jsonb;
  v_config jsonb;
  v_step_config jsonb;
  v_slot_templates jsonb;
  v_required_slots text[];
  v_template text;
  v_slot record;
  v_slot_index integer;
  v_reason text;
  v_player_club_id uuid;
  v_player_opted_out boolean;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items)<>'array'
     OR jsonb_array_length(p_items)<1 OR jsonb_array_length(p_items)>50 THEN
    RAISE EXCEPTION 'Provide 1-50 sequence candidate changes';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) x
    WHERE jsonb_typeof(x)<>'object' OR x->>'id' IS NULL OR
      x->>'player_id' IS NULL OR x->>'playbook_key' IS NULL OR
      x->>'trigger_event_id' IS NULL OR x->>'operation' IS NULL) THEN
    RAISE EXCEPTION 'Every sequence change must include candidate and trigger identity';
  END IF;
  IF EXISTS(SELECT 1 FROM (
      SELECT x->>'id' id,count(*) n FROM jsonb_array_elements(p_items) x GROUP BY x->>'id'
    ) duplicates WHERE n>1)
    OR EXISTS(SELECT 1 FROM (
      SELECT x->>'player_id' player_id,x->>'playbook_key' playbook_key,x->>'step' step,count(*) n
      FROM jsonb_array_elements(p_items) x GROUP BY x->>'player_id',x->>'playbook_key',x->>'step'
    ) duplicates WHERE n>1) THEN
    RAISE EXCEPTION 'Sequence batch candidate and player/step identities must be distinct';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) x
    WHERE x->>'playbook_key'<>'ltp_followup'
      OR x->>'operation' NOT IN ('create','regenerate','reshuffle','retry_context')
      OR COALESCE((x->>'step')::integer,0) NOT IN (1,2)
      OR COALESCE(x->>'status','drafted') NOT IN ('drafted','needs_context','manual_edit','skipped')) THEN
    RAISE EXCEPTION 'Unsupported LTP sequence batch operation';
  END IF;

  -- Serialize batch writes with player opt-out updates. The opt-out trigger
  -- takes this same player-before-sequence lock order before exiting roots.
  FOR v_player_id IN
    SELECT DISTINCT (x->>'player_id')::uuid
    FROM jsonb_array_elements(p_items) x
    ORDER BY (x->>'player_id')::uuid
  LOOP
    SELECT p.club_id,p.opted_out INTO v_player_club_id,v_player_opted_out
    FROM public.players p WHERE p.id=v_player_id FOR UPDATE;
    IF NOT FOUND OR v_player_club_id IS DISTINCT FROM p_club_id THEN
      RAISE EXCEPTION 'An LTP player does not belong to this club';
    END IF;
    IF v_player_opted_out IS TRUE THEN
      RAISE EXCEPTION 'Player has opted out; LTP draft creation or rebuild is prohibited';
    END IF;
  END LOOP;

  -- Sequence creation is only legitimate for the first step. Step 2 must grow
  -- out of an existing, active sequence with real step-1 delivery evidence.
  FOR v_item IN SELECT DISTINCT ON (x->>'player_id')
    x FROM jsonb_array_elements(p_items) x
    WHERE x->>'operation'='create' AND (x->>'step')::integer=1
    ORDER BY x->>'player_id'
  LOOP
    v_player_id:=(v_item->>'player_id')::uuid;
    IF NOT EXISTS(SELECT 1 FROM public.players WHERE id=v_player_id AND club_id=p_club_id) THEN
      RAISE EXCEPTION 'LTP player does not belong to this club';
    END IF;
    INSERT INTO public.retention_sequences(club_id,player_id,playbook_key,trigger_event_id)
    VALUES(p_club_id,v_player_id,'ltp_followup',v_item->>'trigger_event_id')
    ON CONFLICT(club_id,player_id,playbook_key) DO NOTHING;
  END LOOP;

  -- Root locks are always acquired in stable UUID order. They serialize all
  -- two-step mutations, batch sibling steps, inbound exits and send claims.
  FOR v_sequence_id IN
    SELECT DISTINCT s.id
    FROM jsonb_array_elements(p_items) x
    JOIN public.retention_sequences s ON s.club_id=p_club_id
      AND s.player_id=(x->>'player_id')::uuid AND s.playbook_key=x->>'playbook_key'
    ORDER BY s.id
  LOOP
    PERFORM 1 FROM public.retention_sequences WHERE id=v_sequence_id FOR UPDATE;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items) x
      JOIN public.retention_sequences s ON s.club_id=p_club_id
        AND s.player_id=(x->>'player_id')::uuid AND s.playbook_key=x->>'playbook_key')<>
      jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'One or more LTP sequences are missing';
  END IF;
  -- Then lock the existing cohort candidates and linked messages, each in a
  -- consistent order across the whole batch.
  PERFORM c.id FROM public.retention_candidates c
  JOIN jsonb_array_elements(p_items) x ON c.id=(x->>'id')::uuid
    AND c.club_id=p_club_id
  ORDER BY c.id FOR UPDATE OF c;
  PERFORM m.id FROM public.messages m JOIN (
    SELECT DISTINCT c.message_id FROM public.retention_candidates c
    JOIN jsonb_array_elements(p_items) x ON c.id=(x->>'id')::uuid
    WHERE c.club_id=p_club_id AND c.message_id IS NOT NULL
  ) linked ON linked.message_id=m.id
  ORDER BY m.id FOR UPDATE OF m;

  IF EXISTS(SELECT 1 FROM public.players pl JOIN jsonb_array_elements(p_items) x
      ON pl.id=(x->>'player_id')::uuid
      WHERE pl.club_id IS DISTINCT FROM p_club_id) THEN
    RAISE EXCEPTION 'An LTP player does not belong to this club';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.retention_playbooks p WHERE p.key='ltp_followup' AND p.enabled) THEN
    RAISE EXCEPTION 'LTP follow-up playbook is not enabled';
  END IF;
  SELECT ltp_sequence_config INTO v_config FROM public.retention_playbooks WHERE key='ltp_followup';
  IF v_config IS NULL OR jsonb_typeof(v_config->'step1')<>'object'
    OR jsonb_typeof(v_config->'step2')<>'object'
    OR jsonb_typeof(v_config->'step2_gap_days')<>'number'
    OR (v_config->>'step2_gap_days')::numeric NOT BETWEEN 7 AND 30
    OR trunc((v_config->>'step2_gap_days')::numeric)
      IS DISTINCT FROM (v_config->>'step2_gap_days')::numeric THEN
    RAISE EXCEPTION 'LTP phrase-slot configuration is incomplete';
  END IF;

  -- Validate row identity, live-context step marker, exact CAS snapshots,
  -- protected message fields, sequence eligibility, and message safety before
  -- freeing any cohort capacity. An exception rolls back the whole RPC.
  FOR v_item IN SELECT x FROM jsonb_array_elements(p_items) x
    ORDER BY (x->>'id')::uuid
  LOOP
    v_candidate_id:=(v_item->>'id')::uuid;
    v_player_id:=(v_item->>'player_id')::uuid;
    v_step:=(v_item->>'step')::smallint;
    v_operation:=v_item->>'operation';
    v_status:=COALESCE(v_item->>'status','drafted');
    v_context:=v_item->'context';
    SELECT * INTO v_sequence FROM public.retention_sequences
    WHERE club_id=p_club_id AND player_id=v_player_id AND playbook_key='ltp_followup';
    IF NOT FOUND OR v_sequence.sequence_status<>'active' THEN
      RAISE EXCEPTION 'Cannot write a draft for an inactive or exited LTP sequence';
    END IF;
    IF (v_item->>'trigger_event_id') IS DISTINCT FROM v_sequence.trigger_event_id THEN
      RAISE EXCEPTION 'LTP trigger changed since the sequence was opened';
    END IF;
    IF v_context IS NULL OR jsonb_typeof(v_context)<>'object'
       OR v_context->'trigger'->>'event_id' IS DISTINCT FROM v_sequence.trigger_event_id THEN
      RAISE EXCEPTION 'LTP trigger identity must match its existing sequence';
    END IF;
    IF v_status='drafted' THEN
      IF jsonb_typeof(v_context->'ltp_text')<>'object'
         OR (v_context->'ltp_text'->>'step') !~ '^[12]$'
         OR (v_context->'ltp_text'->>'step')::smallint IS DISTINCT FROM v_step THEN
        RAISE EXCEPTION 'LTP draft must include the exact step text-generation marker';
      END IF;
      IF v_context->'ltp_text'->>'opener' IS NULL
         OR v_context->'ltp_text'->>'ltp_date' IS NULL
         OR jsonb_typeof(v_context->'ltp_text'->'slot_indices')<>'object'
         OR COALESCE((v_context->'ltp_text'->>'seed_nonce')::integer,-1)<0
         OR v_context->'trigger'->>'date' IS NULL
         OR (v_context->'ltp_text'->>'ltp_date') ~ '[\/-]'
         OR position(chr(8212) IN v_context->'ltp_text'->>'ltp_date')>0
         OR position(chr(8211) IN v_context->'ltp_text'->>'ltp_date')>0 THEN
        RAISE EXCEPTION 'LTP generated phrases and code-filled facts are required';
      END IF;
      BEGIN v_trigger_date:=(v_context->'trigger'->>'date')::date;
      EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid LTP trigger date'; END;
      IF NULLIF(v_context->>'player_first_name','') IS NULL
         OR lower(btrim(v_context->'ltp_text'->>'ltp_date')) NOT IN (
        lower(to_char(v_trigger_date,'Mon FMDD')),
        lower(replace(to_char(v_trigger_date,'Mon FMDD'),'Sep ','Sept ')),
        lower(to_char(v_trigger_date,'FMMonth FMDD'))
      ) THEN RAISE EXCEPTION 'Code-filled LTP date must identify the recorded trigger date'; END IF;
      v_step_config:=v_config->CASE WHEN v_step=1 THEN 'step1' ELSE 'step2' END;
      v_slot_templates:=v_context->'ltp_text'->'slot_templates';
      IF jsonb_typeof(v_slot_templates)<>'object' THEN
        RAISE EXCEPTION 'LTP generated text must preserve its selected phrase-slot templates';
      END IF;
      IF v_step=1 THEN
        v_required_slots:=CASE WHEN v_context->>'variant'='with_program'
          THEN ARRAY['opener','thanks','next_step','offer']::text[]
          ELSE ARRAY['opener','thanks','offer_no_program']::text[] END;
      ELSE
        v_required_slots:=CASE WHEN v_context->>'variant'='with_program'
          THEN ARRAY['opener','nudge','next_step']::text[]
          ELSE ARRAY['opener','nudge','no_program_cta']::text[] END;
      END IF;
      IF (SELECT array_agg(slot_name ORDER BY slot_name)
          FROM jsonb_object_keys(v_slot_templates) AS template_keys(slot_name))
          IS DISTINCT FROM (SELECT array_agg(slot_name ORDER BY slot_name)
            FROM unnest(v_required_slots) AS required_slots(slot_name))
         OR (SELECT array_agg(slot_name ORDER BY slot_name)
          FROM jsonb_object_keys(v_context->'ltp_text'->'slot_indices') AS index_keys(slot_name))
          IS DISTINCT FROM (SELECT array_agg(slot_name ORDER BY slot_name)
            FROM unnest(v_required_slots) AS required_slots(slot_name)) THEN
        RAISE EXCEPTION 'LTP phrase slot indices do not match their required step/variant';
      END IF;
      FOREACH v_reason IN ARRAY v_required_slots LOOP
        IF (v_context->'ltp_text'->'slot_indices'->>v_reason) !~ '^[0-9]+$' THEN
          RAISE EXCEPTION 'Invalid LTP phrase slot index for %',v_reason;
        END IF;
        v_slot_index:=(v_context->'ltp_text'->'slot_indices'->>v_reason)::integer;
        IF v_slot_index>=(jsonb_array_length(v_step_config->v_reason)) THEN
          RAISE EXCEPTION 'LTP phrase slot index is outside current configuration for %',v_reason;
        END IF;
        v_template:=v_step_config->v_reason->>v_slot_index;
        IF v_slot_templates->>v_reason IS DISTINCT FROM v_template THEN
          RAISE EXCEPTION 'LTP generated phrase does not match current config slot %',v_reason;
        END IF;
      END LOOP;
    END IF;
    IF v_context->>'variant' NOT IN ('with_program','no_program')
       OR COALESCE(v_context->'errors','[]'::jsonb)<>'[]'::jsonb
       OR COALESCE(v_context->'validation_errors','[]'::jsonb)<>'[]'::jsonb
       OR NULLIF(v_context->>'reason','') IS NOT NULL THEN
      IF v_status='drafted' THEN RAISE EXCEPTION 'Only a validated, resolved LTP draft can be saved as drafted'; END IF;
    END IF;
    IF v_status='drafted' THEN
      IF length(btrim(COALESCE(v_item->>'body','')))=0
         OR char_length(v_item->>'body')>320
         OR position(chr(8212) IN v_item->>'body')>0
         OR position(chr(8211) IN v_item->>'body')>0
         OR (v_item->>'body') LIKE '% - %'
         OR left(v_item->>'body',length(v_context->'ltp_text'->>'opener'))
              IS DISTINCT FROM v_context->'ltp_text'->>'opener'
         OR position(v_context->>'player_first_name' IN v_item->>'body')=0 THEN
        RAISE EXCEPTION 'LTP draft text failed identity, 320-character, or dash safeguards';
      END IF;
      IF v_step=1 THEN
        IF position('Learn to Play' IN v_item->>'body')=0
           OR position(v_context->'ltp_text'->>'ltp_date' IN v_item->>'body')=0
           OR position('LTPNEXT25' IN v_item->>'body')=0
           OR v_context->'promo'->>'code' IS DISTINCT FROM 'LTPNEXT25'
           OR position('25%' IN COALESCE(v_context->'promo'->>'offer_text',''))=0
            OR position('25% off' IN lower(COALESCE(v_context->'promo'->>'offer_text','')))=0
            OR position('25% off' IN lower(v_item->>'body'))=0
           OR NULLIF(v_context->>'coupon_warning','') IS NOT NULL THEN
          RAISE EXCEPTION 'Step 1 requires live-verified Learn to Play and LTPNEXT25';
        END IF;
      ELSE
        IF v_context->'promo' IS NOT NULL AND v_context->'promo'<>'null'::jsonb
           OR upper(v_item->>'body') LIKE '%LTPNEXT25%'
           OR (v_item->>'body') ~* '([0-9]+[[:space:]]*(%|percent)|[[:space:]](twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)[[:space:]]+percent)' THEN
          RAISE EXCEPTION 'Step 2 cannot contain a promo code or discount';
        END IF;
      END IF;
      IF v_context->'next_program' IS NULL OR v_context->'next_program'='null'::jsonb THEN
        IF position('https://pbclub.podplay.app' IN v_item->>'body')=0
           OR right(v_item->>'body',length('https://pbclub.podplay.app'))<>'https://pbclub.podplay.app'
           OR COALESCE(v_context->>'booking_url','')<>'https://pbclub.podplay.app' THEN
          RAISE EXCEPTION 'No-program LTP text must end at the approved booking page link';
        END IF;
        IF v_context->'ltp_text'->>'when' IS NOT NULL THEN
          RAISE EXCEPTION 'No-program LTP text must not include a program date';
        END IF;
      ELSE
        IF jsonb_typeof(v_context->'next_program')<>'object'
          OR NULLIF(v_context->'next_program'->>'event_id','') IS NULL
          OR NULLIF(v_context->'next_program'->>'name','') IS NULL
          OR NULLIF(v_context->'next_program'->>'signup_url','') IS NULL
          OR NULLIF(v_context->'ltp_text'->>'when','') IS NULL
          OR position(v_context->'next_program'->>'name' IN v_item->>'body')=0
          OR position(v_context->'ltp_text'->>'when' IN v_item->>'body')=0
          OR right(v_item->>'body',length(v_context->'next_program'->>'signup_url'))
               IS DISTINCT FROM v_context->'next_program'->>'signup_url' THEN
          RAISE EXCEPTION 'With-program LTP text must include its live session, {when}, and last event link';
        END IF;
        IF v_item->>'capacity_event_id' IS DISTINCT FROM v_context->'next_program'->>'event_id'
           OR (v_item->>'open_spots')::integer IS DISTINCT FROM
                (v_context->'next_program'->>'spots_remaining')::integer
           OR COALESCE((v_item->>'open_spots')::integer,0)<1 THEN
          RAISE EXCEPTION 'Live event capacity snapshot does not match the generated session';
        END IF;
        BEGIN v_event_time:=(v_item->>'event_start_time')::timestamptz;
        EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Event start time is required for capacity reservation'; END;
        IF v_event_time IS DISTINCT FROM (v_context->'next_program'->>'start_time')::timestamptz THEN
          RAISE EXCEPTION 'Event capacity reservation has a stale start time';
        END IF;
      END IF;
    ELSIF length(btrim(COALESCE(v_item->>'body','')))>0
       OR length(btrim(COALESCE(v_context->>'reason','')))=0 THEN
      RAISE EXCEPTION 'Non-draft LTP results cannot store active text';
    END IF;

    SELECT * INTO v_candidate FROM public.retention_candidates
    WHERE id=v_candidate_id AND club_id=p_club_id;
    IF v_operation='create' THEN
      IF FOUND OR NULLIF(v_item->>'expected_message_id','') IS NOT NULL
         OR v_item->'expected_body' IS NOT NULL AND v_item->'expected_body'<>'null'::jsonb THEN
        RAISE EXCEPTION 'LTP candidate already exists or has unexpected edit snapshots';
      END IF;
      IF v_step=2 THEN
        IF v_sequence.step1_sent_at IS NULL OR v_sequence.step1_delivery_kind IS DISTINCT FROM 'real'
           OR v_sequence.step1_message_id IS NULL
           OR now()-v_sequence.step1_sent_at <
               make_interval(days=>(v_config->>'step2_gap_days')::integer) THEN
          RAISE EXCEPTION 'Step 2 requires a real step 1 sent at least seven days ago';
        END IF;
        IF public.retention_ltp_has_attendance_since(v_player_id,v_sequence.step1_sent_at) THEN
          RAISE EXCEPTION 'Step 2 is ineligible because the player attended or booked since step 1';
        END IF;
        IF EXISTS(SELECT 1 FROM public.retention_candidates WHERE sequence_id=v_sequence.id AND step=2) THEN
          RAISE EXCEPTION 'Step 2 was already created for this sequence';
        END IF;
      ELSIF EXISTS(SELECT 1 FROM public.retention_candidates
          WHERE sequence_id=v_sequence.id AND step=1) THEN
        RAISE EXCEPTION 'Step 1 was already created for this sequence';
      END IF;
      IF v_status='drafted' AND NOT EXISTS(
        SELECT 1 FROM public.players WHERE id=v_player_id AND club_id=p_club_id
      ) THEN RAISE EXCEPTION 'Player does not belong to club'; END IF;
    ELSE
      IF NOT FOUND THEN RAISE EXCEPTION 'LTP sequence candidate not found'; END IF;
      IF v_candidate.player_id IS DISTINCT FROM v_player_id
         OR v_candidate.playbook_key IS DISTINCT FROM 'ltp_followup'
         OR v_candidate.step IS DISTINCT FROM v_step
         OR v_candidate.sequence_id IS DISTINCT FROM v_sequence.id
         OR v_candidate.trigger_event_id IS DISTINCT FROM v_sequence.trigger_event_id
         OR v_candidate.context IS DISTINCT FROM v_item->'expected_context'
         OR v_candidate.updated_at IS DISTINCT FROM (v_item->>'expected_updated_at')::timestamptz
         OR v_candidate.message_id IS DISTINCT FROM NULLIF(v_item->>'expected_message_id','')::uuid THEN
        RAISE EXCEPTION 'LTP candidate changed since its reviewed snapshot';
      END IF;
      IF v_candidate.status='approved' OR v_candidate.status='sent' OR v_candidate.status='skipped'
         OR v_candidate.status NOT IN ('drafted','needs_context','manual_edit') THEN
        RAISE EXCEPTION 'This LTP sequence state cannot be rebuilt';
      END IF;
      IF v_operation IN ('regenerate','reshuffle') AND v_candidate.status<>'drafted' THEN
        RAISE EXCEPTION 'Only a drafted LTP step can be regenerated or reshuffled';
      END IF;
      IF v_operation='retry_context'
        AND (v_candidate.status<>'needs_context' OR
          COALESCE(v_candidate.context->>'reason','') NOT IN ('context_lookup_failed','no_next_program')) THEN
        RAISE EXCEPTION 'Only an eligible flagged LTP context can retry';
      END IF;
      IF v_operation NOT IN ('regenerate','reshuffle','retry_context') THEN
        RAISE EXCEPTION 'Updating an existing LTP row requires regenerate, reshuffle, or retry_context';
      END IF;
      IF v_candidate.message_id IS NOT NULL THEN
        SELECT * INTO v_message FROM public.messages WHERE id=v_candidate.message_id;
        IF NOT FOUND OR v_message.player_id IS DISTINCT FROM v_player_id
           OR v_message.body IS DISTINCT FROM (v_item->>'expected_body') THEN
          RAISE EXCEPTION 'LTP draft message changed since its reviewed snapshot';
        END IF;
        IF v_message.status IS DISTINCT FROM 'pending'
           OR v_message.approved_at IS NOT NULL OR v_message.approved_by IS NOT NULL
           OR v_message.approved_body IS NOT NULL OR v_message.scheduled_send_at IS NOT NULL
           OR v_message.sent_at IS NOT NULL OR v_message.dispatch_claimed_at IS NOT NULL THEN
          RAISE EXCEPTION 'LTP draft is approved, scheduled, sent, or claimed';
        END IF;
      ELSIF v_item->'expected_body' IS NOT NULL AND v_item->'expected_body'<>'null'::jsonb THEN
        RAISE EXCEPTION 'Unexpected LTP message body for an unlinked candidate';
      END IF;
      IF v_step=2 AND (
        v_sequence.step1_sent_at IS NULL OR v_sequence.step1_delivery_kind IS DISTINCT FROM 'real'
        OR now()-v_sequence.step1_sent_at <
           make_interval(days=>(v_config->>'step2_gap_days')::integer)
        OR public.retention_ltp_has_attendance_since(v_player_id,v_sequence.step1_sent_at)
      ) THEN
        RAISE EXCEPTION 'Step 2 requires a real seven-day step 1 with no intervening attendance';
      END IF;
    END IF;
  END LOOP;

  -- Acquire per-event advisory rows before replacing *any* capacity claim.
  -- Concurrent batches targeting a new, otherwise-unreserved event now serialize.
  FOR v_event_id IN
    SELECT DISTINCT x->>'capacity_event_id' FROM jsonb_array_elements(p_items) x
    WHERE NULLIF(x->>'capacity_event_id','') IS NOT NULL ORDER BY x->>'capacity_event_id'
  LOOP
    INSERT INTO public.retention_capacity_event_locks(club_id,event_id)
    VALUES(p_club_id,v_event_id) ON CONFLICT(club_id,event_id) DO NOTHING;
    PERFORM 1 FROM public.retention_capacity_event_locks
      WHERE club_id=p_club_id AND event_id=v_event_id FOR UPDATE;
  END LOOP;
  DELETE FROM public.retention_capacity_reservations
  WHERE club_id=p_club_id AND event_start_time<=now();
  -- Capacity snapshots are reallocated for the complete cohort in ascending
  -- trigger order. Check true outsider reservations against the lowest current
  -- live-open-spots value supplied by the batch, then reserve one spot at a
  -- time. No RPC success can overbook a shared session.
  DELETE FROM public.retention_capacity_reservations cr
  WHERE cr.candidate_id IN(SELECT (x->>'id')::uuid FROM jsonb_array_elements(p_items) x);
  FOR v_item IN SELECT x FROM jsonb_array_elements(p_items) x
    ORDER BY (x->'context'->'trigger'->>'date')::date NULLS LAST,(x->>'id')::uuid
  LOOP
    v_candidate_id:=(v_item->>'id')::uuid;
    v_player_id:=(v_item->>'player_id')::uuid;
    v_step:=(v_item->>'step')::smallint;
    v_operation:=v_item->>'operation';
    v_status:=COALESCE(v_item->>'status','drafted');
    v_context:=v_item->'context';
    SELECT id INTO v_sequence_id FROM public.retention_sequences
      WHERE club_id=p_club_id AND player_id=v_player_id AND playbook_key='ltp_followup';
    v_message_id:=NULL;

    IF v_operation='create' THEN
      IF v_status='drafted' THEN
        INSERT INTO public.messages(player_id,body,direction,sent_by,status)
        VALUES(v_player_id,btrim(v_item->>'body'),'outbound','agent','pending')
        RETURNING id INTO v_message_id;
      END IF;
      INSERT INTO public.retention_candidates(
        id,club_id,player_id,playbook_key,trigger_event_id,context,status,
        message_id,step,sequence_id,sequence_status
      ) VALUES(
        v_candidate_id,p_club_id,v_player_id,'ltp_followup',v_item->>'trigger_event_id',v_context,v_status,
        v_message_id,v_step,v_sequence_id,'active'
      );
    ELSE
      SELECT * INTO v_candidate FROM public.retention_candidates WHERE id=v_candidate_id;
      IF v_candidate.message_id IS NULL AND v_status='drafted' THEN
        INSERT INTO public.messages(player_id,body,direction,sent_by,status)
        VALUES(v_player_id,btrim(v_item->>'body'),'outbound','agent','pending')
        RETURNING id INTO v_message_id;
      ELSE
        v_message_id:=v_candidate.message_id;
      END IF;
      IF v_message_id IS NOT NULL THEN
        UPDATE public.messages SET
          body=CASE WHEN v_status='drafted' THEN btrim(v_item->>'body') ELSE '' END,
          error_message=CASE WHEN v_status='drafted' THEN NULL ELSE
            COALESCE(NULLIF(v_context->>'reason',''),'LTP context requires operator review') END
        WHERE id=v_message_id;
      END IF;
      UPDATE public.retention_candidates SET context=v_context,status=v_status,
        message_id=v_message_id,sequence_status='active',exited_at=NULL,
        exit_reason=NULL,booked_event_id=NULL,updated_at=now()
      WHERE id=v_candidate_id;
    END IF;
    IF v_status IN ('drafted','manual_edit','approved','sent')
       AND NULLIF(v_item->>'capacity_event_id','') IS NOT NULL THEN
      v_event_id:=v_item->>'capacity_event_id';
      v_event_time:=(v_item->>'event_start_time')::timestamptz;
      SELECT min((x->>'open_spots')::integer) INTO v_open
        FROM jsonb_array_elements(p_items) x WHERE x->>'capacity_event_id'=v_event_id;
      SELECT count(*) INTO v_outside FROM public.retention_capacity_reservations cr
        WHERE cr.club_id=p_club_id AND cr.event_id=v_event_id;
      IF v_outside>=v_open THEN
        RAISE EXCEPTION 'capacity_exhausted: cohort reservations exceed current capacity for event %',v_event_id;
      END IF;
      INSERT INTO public.retention_capacity_reservations(
        candidate_id,club_id,sequence_id,event_id,open_spots,event_start_time
      ) VALUES(v_candidate_id,p_club_id,v_sequence_id,v_event_id,v_open,v_event_time);
    END IF;
    SELECT * INTO v_candidate FROM public.retention_candidates WHERE id=v_candidate_id;
    v_saved:=v_saved||jsonb_build_array(to_jsonb(v_candidate)||
      jsonb_build_object('body',(SELECT body FROM public.messages WHERE id=v_candidate.message_id)));
  END LOOP;
  RETURN v_saved;
END $$;

CREATE OR REPLACE FUNCTION public.retention_sequence_claim(
  p_club_id uuid,p_candidate_id uuid,p_message_id uuid,p_expected_body text,
  p_claimed_at timestamptz,p_expected_context jsonb,p_expected_updated_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.retention_candidates%ROWTYPE; s public.retention_sequences%ROWTYPE;
        m public.messages%ROWTYPE; v_player_opted_out boolean;
BEGIN
  SELECT * INTO c FROM public.retention_candidates
  WHERE id=p_candidate_id AND club_id=p_club_id;
  IF NOT FOUND OR c.playbook_key IS DISTINCT FROM 'ltp_followup'
     OR c.step NOT IN (1,2) OR c.message_id IS DISTINCT FROM p_message_id THEN
    RAISE EXCEPTION 'LTP dispatch candidate/message identity changed';
  END IF;
  SELECT p.opted_out INTO v_player_opted_out FROM public.players p
  WHERE p.id=c.player_id AND p.club_id=p_club_id FOR UPDATE;
  IF NOT FOUND OR v_player_opted_out IS TRUE THEN
    RAISE EXCEPTION 'Player has opted out; LTP message dispatch is prohibited';
  END IF;
  SELECT * INTO s FROM public.retention_sequences WHERE id=c.sequence_id FOR UPDATE;
  IF NOT FOUND OR s.club_id IS DISTINCT FROM p_club_id
     OR s.player_id IS DISTINCT FROM c.player_id
     OR s.playbook_key IS DISTINCT FROM 'ltp_followup'
     OR s.sequence_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'LTP sequence is not active for dispatch';
  END IF;
  SELECT * INTO c FROM public.retention_candidates
  WHERE id=p_candidate_id AND club_id=p_club_id FOR UPDATE;
  IF c.status IS DISTINCT FROM 'approved'
     OR c.sequence_id IS DISTINCT FROM s.id
     OR c.sequence_status IS DISTINCT FROM 'active'
     OR c.context IS DISTINCT FROM p_expected_context
     OR c.updated_at IS DISTINCT FROM p_expected_updated_at
     OR c.context->'ltp_text'->>'step' IS DISTINCT FROM c.step::text THEN
    RAISE EXCEPTION 'LTP candidate is changed, not approved, or has no valid step marker';
  END IF;
  SELECT * INTO m FROM public.messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND OR m.player_id IS DISTINCT FROM c.player_id
     OR m.status IS DISTINCT FROM 'pending'
     OR m.body IS DISTINCT FROM p_expected_body
     OR m.approved_at IS NULL OR m.approved_by IS NULL OR m.approved_body IS NULL
     OR m.scheduled_send_at IS NULL OR m.scheduled_send_at>now()
     OR m.sent_at IS NOT NULL OR m.simulated IS DISTINCT FROM FALSE
     OR m.dispatch_claimed_at IS NOT NULL OR m.dispatch_token IS NOT NULL
     OR m.retention_delivery_kind IS NOT NULL
     OR p_claimed_at IS NULL OR p_claimed_at>now()+interval '30 seconds'
     OR p_claimed_at<now()-interval '2 minutes' THEN
    RAISE EXCEPTION 'LTP message is not dispatchable or its schedule/claim changed';
  END IF;
  IF c.step=2 AND (
    s.step1_sent_at IS NULL OR s.step1_delivery_kind IS DISTINCT FROM 'real'
    OR s.step1_message_id IS NULL
     OR now()-s.step1_sent_at<make_interval(days=>(SELECT (p.ltp_sequence_config->>'step2_gap_days')::integer
       FROM public.retention_playbooks p WHERE p.key='ltp_followup'))
    OR public.retention_ltp_has_attendance_since(c.player_id,s.step1_sent_at)
  ) THEN
    RAISE EXCEPTION 'LTP step 2 requires a real seven-day step 1 with no intervening attendance';
  END IF;
  UPDATE public.messages SET dispatch_claimed_at=p_claimed_at,dispatch_token=NULL
    WHERE id=m.id;
  RETURN to_jsonb(c)||jsonb_build_object(
    'body',m.body,'message_id',m.id,'dispatch_claimed_at',p_claimed_at
  );
END $$;

CREATE OR REPLACE FUNCTION public.retention_sequence_record_send(
  p_club_id uuid,p_message_id uuid,p_delivery_kind text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.retention_candidates%ROWTYPE; s public.retention_sequences%ROWTYPE;
        m public.messages%ROWTYPE; v_ledger public.contact_ledger%ROWTYPE;
        v_candidate_id uuid;
BEGIN
  IF p_delivery_kind NOT IN ('real','test','simulated') OR p_delivery_kind IS NULL THEN
    RAISE EXCEPTION 'Unsupported LTP recipient delivery classification';
  END IF;
  SELECT candidate.* INTO c FROM public.retention_candidates candidate
  WHERE candidate.playbook_key='ltp_followup' AND candidate.club_id=p_club_id
    AND candidate.message_id=p_message_id;
  IF NOT FOUND OR c.step NOT IN (1,2) THEN RAISE EXCEPTION 'LTP sent message candidate not found'; END IF;
  v_candidate_id:=c.id;
  SELECT * INTO s FROM public.retention_sequences WHERE id=c.sequence_id FOR UPDATE;
  IF NOT FOUND OR s.club_id IS DISTINCT FROM p_club_id
     OR s.player_id IS DISTINCT FROM c.player_id
     OR s.playbook_key IS DISTINCT FROM 'ltp_followup' THEN
    RAISE EXCEPTION 'LTP sent message sequence identity is inconsistent';
  END IF;
  SELECT candidate.* INTO c FROM public.retention_candidates candidate
  WHERE candidate.id=v_candidate_id FOR UPDATE;
  SELECT * INTO m FROM public.messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND OR m.player_id IS DISTINCT FROM c.player_id
     OR m.status IS DISTINCT FROM 'sent' OR m.sent_at IS NULL
     OR m.dispatch_claimed_at IS NULL
     OR m.retention_delivery_kind IS DISTINCT FROM p_delivery_kind THEN
    RAISE EXCEPTION 'LTP delivery record requires a persisted sent message and dispatch claim';
  END IF;
  IF p_delivery_kind='simulated' AND m.simulated IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'A simulated LTP send must be explicitly marked simulated';
  END IF;
  IF p_delivery_kind='test' THEN
    SELECT * INTO v_ledger FROM public.contact_ledger
      WHERE message_id=m.id AND is_test IS TRUE
        AND (player_id=c.player_id OR intended_player_id=c.player_id)
      ORDER BY sent_at DESC LIMIT 1;
    IF NOT FOUND OR m.simulated IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'A redirected test send needs its matching test contact-ledger record';
    END IF;
  ELSIF p_delivery_kind='real' THEN
    SELECT * INTO v_ledger FROM public.contact_ledger
      WHERE message_id=m.id AND is_test IS FALSE
        AND (player_id=c.player_id OR intended_player_id=c.player_id)
      ORDER BY sent_at DESC LIMIT 1;
    IF NOT FOUND OR m.simulated IS DISTINCT FROM FALSE
       OR m.delivery_status IS DISTINCT FROM 'delivered' OR m.delivered_at IS NULL THEN
      RAISE EXCEPTION 'A real LTP delivery needs provider delivery and its original-recipient ledger';
    END IF;
  END IF;
  IF c.step=1 THEN
    IF s.step1_message_id IS NOT NULL AND s.step1_message_id IS DISTINCT FROM m.id THEN
      RAISE EXCEPTION 'A different message is already recorded as LTP step 1';
    END IF;
    UPDATE public.retention_sequences
    SET step1_message_id=m.id,step1_sent_at=m.sent_at,step1_delivery_kind=p_delivery_kind,
        updated_at=now()
    WHERE id=s.id RETURNING * INTO s;
  ELSE
    IF s.step2_message_id IS NOT NULL AND s.step2_message_id IS DISTINCT FROM m.id THEN
      RAISE EXCEPTION 'A different message is already recorded as LTP step 2';
    END IF;
    UPDATE public.retention_sequences
    SET step2_message_id=m.id,step2_sent_at=m.sent_at,
        sequence_status=CASE WHEN p_delivery_kind='real' AND sequence_status='active'
          THEN 'completed' ELSE sequence_status END,
        updated_at=now()
    WHERE id=s.id RETURNING * INTO s;
    IF p_delivery_kind='real' AND s.sequence_status='completed' THEN
      UPDATE public.retention_candidates
      SET sequence_status='completed',updated_at=now() WHERE sequence_id=s.id;
      DELETE FROM public.retention_capacity_reservations WHERE sequence_id=s.id;
    END IF;
  END IF;
  IF p_delivery_kind IN ('test','simulated') THEN
    DELETE FROM public.retention_capacity_reservations WHERE candidate_id=c.id;
  END IF;
  RETURN to_jsonb(s);
END $$;

CREATE OR REPLACE FUNCTION public.retention_update_candidate(
  p_id uuid,p_club_id uuid,p_action text,p_body text DEFAULT NULL,
  p_actor text DEFAULT NULL,p_scheduled_at timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.retention_candidates%ROWTYPE; s public.retention_sequences%ROWTYPE;
        m public.messages%ROWTYPE; result jsonb;
BEGIN
  SELECT * INTO c FROM public.retention_candidates WHERE id=p_id AND club_id=p_club_id;
  IF NOT FOUND OR c.playbook_key IS DISTINCT FROM 'ltp_followup' THEN
    RETURN public.retention_update_candidate_legacy(
      p_id,p_club_id,p_action,p_body,p_actor,p_scheduled_at
    );
  END IF;
  SELECT * INTO s FROM public.retention_sequences WHERE id=c.sequence_id FOR UPDATE;
  IF NOT FOUND OR s.sequence_status IS DISTINCT FROM 'active'
     OR c.sequence_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Only an active LTP sequence may be reviewed';
  END IF;
  SELECT * INTO c FROM public.retention_candidates WHERE id=p_id AND club_id=p_club_id FOR UPDATE;
  IF p_action='skip' THEN
    result:=public.retention_update_candidate_legacy(
      p_id,p_club_id,p_action,p_body,p_actor,p_scheduled_at
    );
    DELETE FROM public.retention_capacity_reservations WHERE candidate_id=p_id;
    RETURN result;
  END IF;
  IF c.message_id IS NULL OR c.context->'ltp_text'->>'step' IS DISTINCT FROM c.step::text THEN
    RAISE EXCEPTION 'Rebuild this LTP step before approval';
  END IF;
  SELECT * INTO m FROM public.messages WHERE id=c.message_id FOR UPDATE;
  IF NOT FOUND OR m.player_id IS DISTINCT FROM c.player_id
     OR m.status IS DISTINCT FROM 'pending' OR m.dispatch_claimed_at IS NOT NULL
     OR m.dispatch_token IS NOT NULL OR m.sent_at IS NOT NULL
     OR m.retention_delivery_kind IS NOT NULL THEN
    RAISE EXCEPTION 'LTP message is no longer an unclaimed pending draft';
  END IF;
  IF p_action='edit' THEN
    RAISE EXCEPTION 'Use the validated LTP manual-edit route for text changes';
  END IF;
  IF p_action='approve' THEN
    IF c.status IS DISTINCT FROM 'drafted'
       OR m.approved_at IS NOT NULL OR m.approved_by IS NOT NULL
       OR m.approved_body IS NOT NULL OR m.scheduled_send_at IS NOT NULL THEN
      RAISE EXCEPTION 'Only a fresh unapproved LTP draft can be approved';
    END IF;
    IF p_body IS NULL OR m.body IS DISTINCT FROM p_body
       OR char_length(m.body)>320 OR position(chr(8212) IN m.body)>0
       OR position(chr(8211) IN m.body)>0 OR m.body LIKE '% - %'
       OR left(m.body,length(c.context->'ltp_text'->>'opener'))
          IS DISTINCT FROM c.context->'ltp_text'->>'opener'
       OR position(c.context->>'player_first_name' IN m.body)=0 THEN
      RAISE EXCEPTION 'LTP text changed or no longer satisfies sequence safety checks';
    END IF;
    IF c.step=1 AND (
      position('Learn to Play' IN m.body)=0
      OR position(c.context->'ltp_text'->>'ltp_date' IN m.body)=0
      OR position('LTPNEXT25' IN m.body)=0
      OR c.context->'promo'->>'code' IS DISTINCT FROM 'LTPNEXT25'
      OR position('25%' IN COALESCE(c.context->'promo'->>'offer_text',''))=0
       OR position('25% off' IN lower(COALESCE(c.context->'promo'->>'offer_text','')))=0
       OR position('25% off' IN lower(m.body))=0
      OR NULLIF(c.context->>'coupon_warning','') IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Step 1 lost its verified Learn to Play date or 25%% offer';
    END IF;
    IF c.step=2 AND (
      c.context->'promo' IS NOT NULL AND c.context->'promo'<>'null'::jsonb
      OR upper(m.body) LIKE '%LTPNEXT25%'
      OR m.body ~* '([0-9]+[[:space:]]*(%|percent)|[[:space:]](twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)[[:space:]]+percent)'
    ) THEN
      RAISE EXCEPTION 'Step 2 must not contain a coupon or discount';
    END IF;
    IF c.context->'next_program' IS NULL OR c.context->'next_program'='null'::jsonb THEN
      IF right(m.body,length('https://pbclub.podplay.app'))<>'https://pbclub.podplay.app' THEN
        RAISE EXCEPTION 'LTP text lost its final approved booking-page link';
      END IF;
    ELSIF NULLIF(c.context->'next_program'->>'event_id','') IS NULL
      OR NULLIF(c.context->'next_program'->>'name','') IS NULL
      OR NULLIF(c.context->'next_program'->>'signup_url','') IS NULL
      OR NULLIF(c.context->'ltp_text'->>'when','') IS NULL
      OR position(c.context->'next_program'->>'name' IN m.body)=0
      OR position(c.context->'ltp_text'->>'when' IN m.body)=0
      OR right(m.body,length(c.context->'next_program'->>'signup_url'))
         IS DISTINCT FROM c.context->'next_program'->>'signup_url' THEN
      RAISE EXCEPTION 'LTP text lost its selected live program, date, or final event link';
    END IF;
    result:=public.retention_update_candidate_legacy(
      p_id,p_club_id,p_action,p_body,p_actor,p_scheduled_at
    );
    RETURN result;
  END IF;
  RAISE EXCEPTION 'Unknown candidate action';
END $$;

CREATE OR REPLACE FUNCTION public.retention_schema_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT
    to_regprocedure('public.retention_create_candidate(uuid,uuid,text,text,jsonb,text,text)') IS NOT NULL
    AND to_regprocedure('public.retention_regenerate_draft(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text)') IS NOT NULL
    AND to_regprocedure('public.retention_manual_edit_candidate(uuid,uuid,text,text,jsonb,timestamptz)') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid='public.retention_candidates'::regclass
        AND conname='retention_candidates_status_check'
        AND pg_get_constraintdef(oid) LIKE '%needs_context%'
        AND pg_get_constraintdef(oid) LIKE '%manual_edit%'
    )
$$;

CREATE OR REPLACE FUNCTION public.retention_context_retry_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT public.retention_schema_ready()
    AND to_regprocedure('public.retention_retry_context(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text,uuid)') IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.retention_sequence_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT public.retention_schema_ready()
    AND public.retention_context_retry_ready()
    AND to_regprocedure('public.retention_sequence_save_batch(uuid,jsonb)') IS NOT NULL
    AND to_regprocedure('public.retention_sequence_transition(uuid,uuid,text,text,text,text)') IS NOT NULL
    AND to_regprocedure('public.retention_sequence_session_changed(uuid,uuid,timestamptz)') IS NOT NULL
    AND to_regprocedure('public.retention_sequence_claim(uuid,uuid,uuid,text,timestamptz,jsonb,timestamptz)') IS NOT NULL
    AND to_regprocedure('public.retention_sequence_record_send(uuid,uuid,text)') IS NOT NULL
    AND to_regprocedure('public.retention_sequence_due_step2(uuid)') IS NOT NULL
    AND to_regprocedure('public.retention_sequence_player_optout_changed()') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.players'::regclass
        AND tgname='players_ltp_retention_optout' AND NOT tgisinternal
        AND tgenabled='O'
        AND tgfoid='public.retention_sequence_player_optout_changed()'::regprocedure
    )
    AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.retention_sequences'::regclass AND c.relrowsecurity)
    AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.retention_capacity_event_locks'::regclass AND c.relrowsecurity)
    AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.retention_capacity_reservations'::regclass AND c.relrowsecurity)
    AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='retention_candidates_player_playbook_step_unique')
    AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='retention_candidates_sequence_step_unique')
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid='public.retention_candidates'::regclass
        AND conname='retention_candidates_ltp_sequence_identity_check'
    )
    AND EXISTS (
      SELECT 1 FROM public.retention_playbooks
      WHERE key='ltp_followup'
        AND jsonb_typeof(ltp_sequence_config->'step1')='object'
        AND jsonb_typeof(ltp_sequence_config->'step2')='object'
        AND jsonb_typeof(ltp_sequence_config->'step2_gap_days')='number'
        AND (ltp_sequence_config->>'step2_gap_days')::numeric BETWEEN 7 AND 30
        AND trunc((ltp_sequence_config->>'step2_gap_days')::numeric)
          =(ltp_sequence_config->>'step2_gap_days')::numeric
    )
$$;

-- Retired functions remain owner-private implementation details, never directly
-- callable from PostgREST or the service API. The guarded SECURITY DEFINER
-- wrappers invoke them as owner for unrelated legacy playbooks.
REVOKE ALL ON FUNCTION public.retention_create_candidate_legacy(uuid,uuid,text,text,jsonb,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.retention_create_draft_legacy(uuid,uuid,text,text,jsonb,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.retention_regenerate_draft_legacy(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.retention_manual_edit_candidate_legacy(uuid,uuid,text,text,jsonb,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.retention_update_candidate_legacy(uuid,uuid,text,text,text,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.retention_retry_context_legacy(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION public.retention_create_candidate(uuid,uuid,text,text,jsonb,text,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_create_draft(uuid,uuid,text,text,jsonb,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_regenerate_draft(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_manual_edit_candidate(uuid,uuid,text,text,jsonb,timestamptz)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_update_candidate(uuid,uuid,text,text,text,timestamptz)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_retry_context(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text,uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_schema_ready() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_context_retry_ready() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_sequence_ready() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_sequence_save_batch(uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_sequence_transition(uuid,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_sequence_session_changed(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_sequence_claim(uuid,uuid,uuid,text,timestamptz,jsonb,timestamptz)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_sequence_record_send(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_sequence_due_step2(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.retention_ltp_has_attendance_since(uuid,timestamptz,text)
  FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION public.retention_create_candidate(uuid,uuid,text,text,jsonb,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_create_draft(uuid,uuid,text,text,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_regenerate_draft(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_manual_edit_candidate(uuid,uuid,text,text,jsonb,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_update_candidate(uuid,uuid,text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_retry_context(uuid,uuid,text,jsonb,timestamptz,text,jsonb,text,text,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_schema_ready() TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_context_retry_ready() TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_sequence_ready() TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_sequence_save_batch(uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_sequence_transition(uuid,uuid,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_sequence_session_changed(uuid,uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_sequence_claim(uuid,uuid,uuid,text,timestamptz,jsonb,timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_sequence_record_send(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_sequence_due_step2(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.retention_ltp_has_attendance_since(uuid,timestamptz,text) TO service_role;

COMMIT;
NOTIFY pgrst,'reload schema';

-- Read-only verification is performed by the operator in the SAME Supabase
-- SQL Editor after this migration commits. The application never runs this file.
SELECT public.retention_schema_ready() AS retention_schema_ready;
SELECT public.retention_context_retry_ready() AS retention_context_retry_ready;
SELECT public.retention_sequence_ready() AS retention_sequence_ready;
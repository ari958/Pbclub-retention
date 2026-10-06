-- Synthetic database only. No production connection or player data.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.clubs(id uuid PRIMARY KEY);
CREATE TABLE public.players(id uuid PRIMARY KEY,club_id uuid,opted_out boolean DEFAULT false);
CREATE TABLE public.messages(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),player_id uuid,body text,status text,
  direction text,sent_by text,approved_at timestamptz,approved_by text,approved_body text,
  scheduled_send_at timestamptz,sent_at timestamptz DEFAULT now(),simulated boolean DEFAULT false,
  retention_delivery_kind text,dispatch_claimed_at timestamptz,dispatch_token uuid,twilio_message_sid text,
  delivery_status text,delivered_at timestamptz,error_message text
);
CREATE TABLE public.retention_playbooks(key text PRIMARY KEY,enabled boolean,ltp_sequence_config jsonb);
CREATE TABLE public.retention_sequences(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,player_id uuid,playbook_key text,
  trigger_event_id text,sequence_status text DEFAULT 'active',exited_at timestamptz,
  exit_reason text,booked_event_id text,step1_sent_at timestamptz,step1_message_id uuid,
  step1_delivery_kind text,step2_sent_at timestamptz,step2_message_id uuid,
  created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
  UNIQUE(club_id,player_id,playbook_key)
);
CREATE TABLE public.retention_candidates(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,player_id uuid,playbook_key text,
  trigger_event_id text,context jsonb,status text,message_id uuid,step smallint,
  sequence_id uuid,sequence_status text DEFAULT 'active',exited_at timestamptz,
  exit_reason text,booked_event_id text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
  UNIQUE(sequence_id,step)
);
CREATE TABLE public.retention_capacity_event_locks(club_id uuid,event_id text,PRIMARY KEY(club_id,event_id));
CREATE TABLE public.retention_capacity_reservations(
  candidate_id uuid PRIMARY KEY,club_id uuid,sequence_id uuid,event_id text,
  open_spots integer,event_start_time timestamptz,reserved_at timestamptz DEFAULT now()
);
CREATE TABLE public.contact_ledger(
  message_id uuid,is_test boolean,player_id uuid,intended_player_id uuid,sent_at timestamptz
);
CREATE TABLE public.attendances(player_id uuid,attended_at timestamptz,event_id text);
CREATE FUNCTION public.retention_ltp_has_attendance_since(player uuid,cutoff timestamptz)
RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM public.attendances WHERE player_id=player AND attended_at>cutoff)
$$;
CREATE FUNCTION public.fixture_assert(value boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;

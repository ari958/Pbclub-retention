-- External Supabase SQL Editor. PREPARED ONLY: do not apply automatically.
-- Additive only: one new table. No existing table, column, constraint or grant
-- changes, so member sends, contact_ledger budgets and reports are untouched.
--
-- Why: operator test messages were stored as public.messages rows with
-- player_id NULL, but the live messages.player_id is NOT NULL, and the live
-- contact_ledger CHECKs reject purpose='operator_test' and a JSON outcome
-- (verified 2026-10-09). A test text to the operator's own phone is not a
-- player contact, so it gets its own audit table instead.
--
-- Reapplying is safe (IF NOT EXISTS throughout).
BEGIN;
CREATE TABLE IF NOT EXISTS public.operator_test_messages (
  id uuid PRIMARY KEY,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 200),
  -- pending: recorded, not yet accepted by Twilio. sent: Twilio accepted it.
  -- failed: refused before transport, ambiguous transport error, or a failed receipt.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  twilio_message_sid text UNIQUE,
  -- Twilio's own status vocabulary (queued, sent, delivered, undelivered, ...).
  delivery_status text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS operator_test_messages_club_time
  ON public.operator_test_messages(club_id, created_at DESC);
-- Private operator audit. Access only through the operator-authenticated API.
ALTER TABLE public.operator_test_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operator_test_messages FROM PUBLIC, anon, authenticated;
-- Supabase's default privileges grant service_role ALL (including DELETE and
-- TRUNCATE) on every new table. The API never deletes test history, so take
-- that back before granting the exact set. Found when applying in production.
REVOKE ALL ON public.operator_test_messages FROM service_role;
GRANT SELECT, INSERT, UPDATE ON public.operator_test_messages TO service_role;
COMMIT;

-- Read-only check after applying. Expect 11 columns, rls_enabled = true, no
-- rows for anon or authenticated, and service_role with exactly
-- INSERT,SELECT,UPDATE (the owner role keeps full privileges):
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='operator_test_messages';
-- SELECT relrowsecurity AS rls_enabled FROM pg_class WHERE oid='public.operator_test_messages'::regclass;
-- SELECT grantee, string_agg(privilege_type, ',') FROM information_schema.role_table_grants
--  WHERE table_schema='public' AND table_name='operator_test_messages' GROUP BY grantee;

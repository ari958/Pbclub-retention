-- Migration 008 — SMS consent records
-- Run in Supabase SQL editor.
-- Adds:
--   1. sms_consent_records  — durable per-submission consent record (matched + unmatched leads)
--   2. players.consent_source       — 'web_form' | 'podplay' | null
--   3. players.sms_consented_at     — timestamp of the originating consent submission
--
-- This migration is idempotent (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Safe to re-run.

-- ── 1. sms_consent_records ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sms_consent_records (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id         uuid         NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  player_id       uuid         REFERENCES public.players(id) ON DELETE SET NULL,  -- nullable: unmatched leads
  email           text         NOT NULL,
  phone_e164      text         NOT NULL,
  first_name      text,
  last_name       text,
  consented_at    timestamptz  NOT NULL,   -- submission timestamp from CSV (never import date)
  consent_source  text         NOT NULL DEFAULT 'web_form',
  import_batch    text         NOT NULL,   -- filename + import timestamp; traceable/reversible
  matched         boolean      NOT NULL DEFAULT false,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (club_id, email)
);

CREATE INDEX IF NOT EXISTS idx_sms_consent_phone    ON public.sms_consent_records (phone_e164);
CREATE INDEX IF NOT EXISTS idx_sms_consent_player   ON public.sms_consent_records (player_id) WHERE player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_consent_batch    ON public.sms_consent_records (import_batch);

-- Row-level security
ALTER TABLE public.sms_consent_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Club members can read consent records" ON public.sms_consent_records;
CREATE POLICY "Club members can read consent records"
  ON public.sms_consent_records FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Service role full access consent records" ON public.sms_consent_records;
CREATE POLICY "Service role full access consent records"
  ON public.sms_consent_records FOR ALL
  USING (auth.role() = 'service_role');

-- Grants
GRANT SELECT ON public.sms_consent_records TO anon, authenticated;
GRANT ALL    ON public.sms_consent_records TO service_role;

-- ── 2. Add consent columns to players ────────────────────────────────────────

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS consent_source   text,
  ADD COLUMN IF NOT EXISTS sms_consented_at timestamptz;

COMMENT ON COLUMN public.players.consent_source   IS 'Origin of SMS consent: web_form | podplay | null (unknown)';
COMMENT ON COLUMN public.players.sms_consented_at IS 'Timestamp of the originating consent submission (from source, never import date)';

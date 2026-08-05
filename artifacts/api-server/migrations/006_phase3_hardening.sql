-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006 — Phase 3: Operational Hardening + Clinic Promotion
-- Run in Supabase SQL editor (service_role required).
-- Safe to re-run: all DDL uses IF NOT EXISTS / IF EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. event_fill metadata columns (migration 005 not applied) ───────────────
--
-- Adds event_name and podplay_type so the backtest can apply keyword and
-- podplay_types match_rules from the rule spec. Without these columns the
-- backtest falls back to archetype_ids-only matching and skips keyword/type
-- filters (with a migration_required_note in the response).

ALTER TABLE event_fill
  ADD COLUMN IF NOT EXISTS event_name   TEXT,
  ADD COLUMN IF NOT EXISTS podplay_type TEXT;

-- ── 2. Job heartbeat ──────────────────────────────────────────────────────────
--
-- last_heartbeat is updated every ~30 s during long-running sync loops.
-- reclaimStaleJobs() in jobStore.ts checks: status='running' AND
-- last_heartbeat < now() - interval '5 minutes' → set to error.
-- This means a job that crashes mid-run is auto-recovered the next time
-- startJob() is called or the status endpoint is polled.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ;

-- ── 3. Extend programming_decisions.decision to allow PROMOTE ────────────────
--
-- The existing CHECK only permits CANCEL | ALERT | NO_ACTION.
-- Phase 3 adds a PROMOTE action for the T-18h clinic promotion checkpoint.
-- We drop + recreate the constraint because ALTER CONSTRAINT is not supported
-- for CHECK constraints in PostgreSQL.

ALTER TABLE programming_decisions
  DROP CONSTRAINT IF EXISTS programming_decisions_decision_check;

ALTER TABLE programming_decisions
  ADD CONSTRAINT programming_decisions_decision_check
    CHECK (decision IN ('CANCEL', 'ALERT', 'PROMOTE', 'NO_ACTION'));

-- ── 4. promotion_candidates ───────────────────────────────────────────────────
--
-- One row per (decision_id, player_id): the ranked audience for a PROMOTE
-- decision. Stores filtering outcome and scoring reasons.
-- This table is DATA ONLY — nothing here triggers a send.
-- The unique constraint on (decision_id, player_id) prevents double-ranking
-- on re-runs; write is INSERT ... ON CONFLICT DO UPDATE (upsert to refresh
-- scores without accumulating duplicates).

CREATE TABLE IF NOT EXISTS promotion_candidates (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id       uuid        NOT NULL
                                REFERENCES programming_decisions(id) ON DELETE CASCADE,
  player_id         uuid        NOT NULL
                                REFERENCES players(id) ON DELETE CASCADE,
  rank              int         NOT NULL,
  score             numeric     NOT NULL DEFAULT 0,
  reasons           jsonb       NOT NULL DEFAULT '{}',
  eligible          boolean     NOT NULL DEFAULT true,
  ineligible_reason text,
  UNIQUE (decision_id, player_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promotion_candidates_decision_idx
  ON promotion_candidates (decision_id, rank);

CREATE INDEX IF NOT EXISTS promotion_candidates_player_idx
  ON promotion_candidates (player_id);

-- ── updated_at trigger ────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_promotion_candidates_updated_at'
  ) THEN
    CREATE TRIGGER trg_promotion_candidates_updated_at
      BEFORE UPDATE ON promotion_candidates
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE promotion_candidates ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'promotion_candidates'
      AND policyname = 'service_role_all_promotion_candidates'
  ) THEN
    CREATE POLICY service_role_all_promotion_candidates
      ON promotion_candidates FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'promotion_candidates'
      AND policyname = 'anon_read_promotion_candidates'
  ) THEN
    CREATE POLICY anon_read_promotion_candidates
      ON promotion_candidates FOR SELECT TO anon USING (true);
  END IF;
END $$;

-- ── Grants ────────────────────────────────────────────────────────────────────

GRANT SELECT ON promotion_candidates TO anon;
GRANT ALL    ON promotion_candidates TO service_role;
GRANT SELECT ON TABLE event_fill TO anon;
GRANT ALL    ON TABLE event_fill TO service_role;

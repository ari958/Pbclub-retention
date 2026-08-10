-- Migration 007 — Contact Ledger + Experiment Module
-- Run in Supabase SQL editor (https://knblhxfwvebxntoshiqm.supabase.co)
--
-- Creates:
--   1. contact_ledger         — promotional send history (was deferred from Phase 3.4)
--   2. contact_budget column  — per-rule budget override on programming_rules
--   3. outreach_experiments   — experiment definitions
--   4. experiment_participants — per-participant randomization + outcome records

-- ── 1. contact_ledger ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_ledger (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id        uuid        NOT NULL REFERENCES clubs(id),
  player_id      uuid        NOT NULL REFERENCES players(id),
  decision_id    uuid        REFERENCES programming_decisions(id),
  experiment_id  uuid,                             -- FK added after outreach_experiments exists
  source         text        NOT NULL CHECK (source IN ('promotion','experiment','manual')),
  channel        text        NOT NULL DEFAULT 'sms',
  purpose        text        NOT NULL DEFAULT 'promotion',
  sent_at        timestamptz NOT NULL DEFAULT now(),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_ledger_club_player_idx  ON contact_ledger(club_id, player_id, sent_at);
CREATE INDEX IF NOT EXISTS contact_ledger_purpose_idx      ON contact_ledger(club_id, purpose, sent_at);

-- ── 2. contact_budget column on programming_rules ────────────────────────────
ALTER TABLE programming_rules ADD COLUMN IF NOT EXISTS contact_budget jsonb;

-- ── 3. outreach_experiments ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_experiments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id             uuid        NOT NULL REFERENCES clubs(id),
  name                text        NOT NULL,
  event_id            text        NOT NULL,
  event_name          text        NOT NULL,
  event_start         timestamptz NOT NULL,
  decision_id         uuid        REFERENCES programming_decisions(id),
  status              text        NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft','ready','sent','measuring','complete')),
  treatment_pct       numeric     NOT NULL DEFAULT 0.70,
  randomized_at       timestamptz,
  sent_at             timestamptz,
  notes               text,
  randomization_seed  text,
  pool_size           int,                          -- qualifying candidates at randomization time
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ── 4. experiment_participants ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS experiment_participants (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id         uuid        NOT NULL REFERENCES outreach_experiments(id) ON DELETE CASCADE,
  player_id             uuid        NOT NULL REFERENCES players(id),
  arm                   text        NOT NULL CHECK (arm IN ('treatment','control')),
  rank                  int,
  score                 numeric,
  reasons               jsonb,
  vetoed                boolean     NOT NULL DEFAULT false,
  veto_reason           text,
  message_text          text,
  sent_at               timestamptz,
  channel               text        DEFAULT 'sms',
  -- Outcome columns (populated by measurement job)
  booked_target_session boolean,
  attended_within_30d   boolean,
  first_attendance_at   timestamptz,
  outcome_measured_at   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, player_id)
);

CREATE INDEX IF NOT EXISTS experiment_participants_experiment_id_idx
  ON experiment_participants(experiment_id);
CREATE INDEX IF NOT EXISTS experiment_participants_player_id_idx
  ON experiment_participants(player_id);
CREATE INDEX IF NOT EXISTS experiment_participants_control_active_idx
  ON experiment_participants(player_id)
  WHERE arm = 'control' AND vetoed = false;

-- FK from contact_ledger back to experiments (safe now that the table exists)
ALTER TABLE contact_ledger
  ADD CONSTRAINT IF NOT EXISTS contact_ledger_experiment_id_fk
  FOREIGN KEY (experiment_id) REFERENCES outreach_experiments(id);

CREATE INDEX IF NOT EXISTS contact_ledger_experiment_idx
  ON contact_ledger(experiment_id) WHERE experiment_id IS NOT NULL;

-- ── 5. updated_at triggers ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_outreach_experiments_updated_at ON outreach_experiments;
CREATE TRIGGER trg_outreach_experiments_updated_at
  BEFORE UPDATE ON outreach_experiments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_experiment_participants_updated_at ON experiment_participants;
CREATE TRIGGER trg_experiment_participants_updated_at
  BEFORE UPDATE ON experiment_participants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 6. Row-level security + grants ──────────────────────────────────────────
ALTER TABLE contact_ledger          ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_experiments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_participants  ENABLE ROW LEVEL SECURITY;

GRANT ALL ON contact_ledger, outreach_experiments, experiment_participants TO service_role;
GRANT ALL ON contact_ledger, outreach_experiments, experiment_participants TO authenticated;

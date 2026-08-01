-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004 — Programming Agent tables
-- Run in Supabase SQL editor (service_role required).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── programming_rules ─────────────────────────────────────────────────────────
--
-- One row per club rule. The `checkpoints` array drives when evaluations fire.
-- mode = 'shadow'  means evaluate but never execute (no PodPlay writes).
--
-- checkpoints element shape:
--   { index: int, offset_hours: int, min_signups: int, action: 'CANCEL'|'ALERT' }
--
-- match_rules element shape (all optional, ANDed together):
--   { archetype_ids?: string[], keywords?: string[], podplay_types?: string[] }

CREATE TABLE IF NOT EXISTS programming_rules (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id         uuid        NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  enabled         boolean     NOT NULL DEFAULT false,
  match_rules     jsonb       NOT NULL DEFAULT '{}',
  checkpoints     jsonb       NOT NULL DEFAULT '[]',
  mode            text        NOT NULL DEFAULT 'shadow'
                              CHECK (mode IN ('shadow', 'live')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS programming_rules_club_idx
  ON programming_rules (club_id)
  WHERE enabled = true;

-- ── programming_decisions ──────────────────────────────────────────────────────
--
-- Append-only evaluation log. One row per (event_id, checkpoint_index) pair.
-- UNIQUE constraint enforces idempotency — re-running the evaluator on the same
-- event+checkpoint produces a conflict on insert, not a duplicate row.
--
-- native_* fields capture what PodPlay's own rule would have done at eval time,
-- enabling side-by-side comparison on the dashboard.

CREATE TABLE IF NOT EXISTS programming_decisions (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id                   uuid        NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  event_id                  text        NOT NULL,
  checkpoint_index          int         NOT NULL,
  UNIQUE (event_id, checkpoint_index),

  evaluated_at              timestamptz NOT NULL DEFAULT now(),
  rule_id                   uuid        REFERENCES programming_rules(id) ON DELETE SET NULL,
  rule_name                 text,

  -- event snapshot at eval time
  event_name                text,
  event_start_time          timestamptz,
  archetype_id              uuid,

  -- signup state
  signup_count              int         NOT NULL,
  total_teams               int         NOT NULL,
  hours_before_start        numeric(8,2) NOT NULL,
  checkpoint_offset_hours   int         NOT NULL,
  checkpoint_min_signups    int         NOT NULL,

  -- agent decision
  decision                  text        NOT NULL
                            CHECK (decision IN ('CANCEL', 'ALERT', 'NO_ACTION')),
  mode                      text        NOT NULL DEFAULT 'shadow'
                            CHECK (mode IN ('shadow', 'live')),
  executed                  boolean     NOT NULL DEFAULT false,

  -- native PodPlay rule snapshot
  native_threshold          int,
  native_hours_before       numeric(8,2),
  native_would_cancel       boolean,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS programming_decisions_club_idx
  ON programming_decisions (club_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS programming_decisions_event_idx
  ON programming_decisions (event_id);

-- ── programming_notifications ─────────────────────────────────────────────────
--
-- Unused this phase — schema reserved for Phase 3 (SMS/notify on decision).
-- UNIQUE(decision_id, player_id, channel) prevents double-send on re-run.

CREATE TABLE IF NOT EXISTS programming_notifications (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id   uuid        NOT NULL REFERENCES programming_decisions(id) ON DELETE CASCADE,
  player_id     uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  channel       text        NOT NULL DEFAULT 'sms'
                            CHECK (channel IN ('sms', 'email', 'push')),
  status        text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  UNIQUE (decision_id, player_id, channel),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── updated_at triggers ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_programming_rules_updated_at'
  ) THEN
    CREATE TRIGGER trg_programming_rules_updated_at
      BEFORE UPDATE ON programming_rules
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_programming_decisions_updated_at'
  ) THEN
    CREATE TRIGGER trg_programming_decisions_updated_at
      BEFORE UPDATE ON programming_decisions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_programming_notifications_updated_at'
  ) THEN
    CREATE TRIGGER trg_programming_notifications_updated_at
      BEFORE UPDATE ON programming_notifications
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE programming_rules          ENABLE ROW LEVEL SECURITY;
ALTER TABLE programming_decisions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE programming_notifications  ENABLE ROW LEVEL SECURITY;

-- service_role: full access
CREATE POLICY service_role_all_programming_rules
  ON programming_rules FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all_programming_decisions
  ON programming_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_all_programming_notifications
  ON programming_notifications FOR ALL TO service_role USING (true) WITH CHECK (true);

-- anon: read-only
CREATE POLICY anon_read_programming_rules
  ON programming_rules FOR SELECT TO anon USING (true);
CREATE POLICY anon_read_programming_decisions
  ON programming_decisions FOR SELECT TO anon USING (true);
CREATE POLICY anon_read_programming_notifications
  ON programming_notifications FOR SELECT TO anon USING (true);

-- ── Grants ────────────────────────────────────────────────────────────────────

GRANT SELECT ON programming_rules          TO anon;
GRANT SELECT ON programming_decisions      TO anon;
GRANT SELECT ON programming_notifications  TO anon;

GRANT ALL ON programming_rules          TO service_role;
GRANT ALL ON programming_decisions      TO service_role;
GRANT ALL ON programming_notifications  TO service_role;

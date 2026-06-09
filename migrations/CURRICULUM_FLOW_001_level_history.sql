-- ============================================================
-- CURRICULUM_FLOW_001 — level_history table
-- ============================================================
-- APPEND-ONLY SPINE of the Curriculum Flow feature.
-- Rows MUST NOT be UPDATEd or DELETEd except via ON DELETE CASCADE
-- from the players table.  To correct a bad assignment, INSERT a new
-- row and leave the original intact.
-- ============================================================

CREATE TABLE IF NOT EXISTS level_history (
  id           bigserial    PRIMARY KEY,
  player_id    uuid         NOT NULL REFERENCES players(id)  ON DELETE CASCADE,
  club_id      uuid         NOT NULL REFERENCES clubs(id),
  from_level   text,                    -- NULL = first known assignment
  to_level     text         NOT NULL,
  from_rank    int,                     -- NULL = first known assignment
  to_rank      int          NOT NULL,
  source       text         NOT NULL
                            CHECK (source IN ('coach', 'backfill', 'behavior_inferred', 'synthetic')),
  note         text,
  assigned_at  timestamptz  NOT NULL DEFAULT now(),
  created_at   timestamptz  NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_level_history_player_assigned
  ON level_history (player_id, assigned_at DESC);

CREATE INDEX IF NOT EXISTS idx_level_history_club
  ON level_history (club_id);

-- Row-Level Security
ALTER TABLE level_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_all_level_history
  ON level_history FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY anon_read_level_history
  ON level_history FOR SELECT TO anon
  USING (true);

-- Default grants (covers all tables)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL    ON ALL TABLES IN SCHEMA public TO service_role;

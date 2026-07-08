-- ── PROGRAM_CATALOG_002: event_fill table ────────────────────────────────────
-- Stores per-event final capacity + signups fetched from PodPlay GET /events/{id}.
-- fill_rate = final_signups / total_teams  (totalTeams is seat count; teamSize NOT used)
-- Numerator: signups._total (all registrants, full-population signal)
-- Denominator: totalTeams (capacity slots, not team count × team size)
--
-- Run ONCE in Supabase SQL Editor after PROGRAM_CATALOG_001 has been applied.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS event_fill (
  event_id       TEXT        PRIMARY KEY,
  club_id        UUID        NOT NULL,
  archetype_id   UUID,                        -- FK to programs.id; NULL if unclassified
  total_teams    INTEGER     NOT NULL,
  final_signups  INTEGER     NOT NULL,
  fill_rate      NUMERIC(6,4),                -- NULL when total_teams = 0
  start_time     TIMESTAMPTZ NOT NULL,
  is_daily_peak  BOOLEAN     NOT NULL DEFAULT false,
  is_peak_season BOOLEAN     NOT NULL DEFAULT false,
  is_canceled    BOOLEAN     NOT NULL DEFAULT false,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index used by the rating engine GROUP BY query
CREATE INDEX IF NOT EXISTS event_fill_rating_idx
  ON event_fill (club_id, archetype_id, is_daily_peak, is_peak_season)
  WHERE is_canceled = false
    AND fill_rate IS NOT NULL
    AND archetype_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON event_fill TO service_role;
GRANT SELECT ON event_fill TO anon;

-- Job tracker row for nightly incremental sync
INSERT INTO jobs (id, status)
VALUES ('event_fill_sync', 'idle')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- CURRICULUM_FLOW_002 — backfill seed from coach_assigned_level
-- ============================================================
-- Idempotent: the WHERE NOT EXISTS guard prevents duplicate seeds
-- on re-run.  Safe to execute multiple times.
--
-- Requires: CURRICULUM_FLOW_001 (level_history table) already applied.
-- ============================================================

INSERT INTO level_history
  (player_id, club_id, from_level, to_level, from_rank, to_rank,
   source, assigned_at, note)
SELECT
  p.id                                            AS player_id,
  p.club_id,
  NULL                                            AS from_level,
  p.coach_assigned_level                          AS to_level,
  NULL                                            AS from_rank,
  lt.rank                                         AS to_rank,
  'backfill'                                      AS source,
  COALESCE(p.updated_at, now())                   AS assigned_at,
  'Seeded from coach_assigned_level at backfill'  AS note
FROM players p
JOIN level_taxonomy lt
  ON lt.club_id = p.club_id
 AND lt.level   = p.coach_assigned_level
WHERE p.coach_assigned_level IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM level_history lh WHERE lh.player_id = p.id
  );

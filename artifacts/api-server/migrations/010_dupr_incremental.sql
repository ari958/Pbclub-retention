-- Run in the Supabase SQL editor before deploying the incremental DUPR sync.
-- Track checks separately from the source's rating timestamp: a player with
-- no rating still needs a cooldown, and source timestamps need not change.
ALTER TABLE players ADD COLUMN IF NOT EXISTS dupr_checked_at timestamptz;

CREATE OR REPLACE FUNCTION apply_dupr_rating_checks(p_club_id uuid, p_checks jsonb)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer;
BEGIN
  IF jsonb_typeof(p_checks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_checks must be an array';
  END IF;

  WITH checks AS (
    SELECT id, rating, rating_updated_at, checked_at
    FROM jsonb_to_recordset(p_checks) AS r(
      id uuid,
      rating double precision,
      rating_updated_at timestamptz,
      checked_at timestamptz
    )
  )
  UPDATE players AS p
  SET dupr_checked_at = c.checked_at,
      dupr_rating = COALESCE(c.rating, p.dupr_rating),
      dupr_updated_at = CASE WHEN c.rating IS NOT NULL
        THEN COALESCE(c.rating_updated_at, c.checked_at)
        ELSE p.dupr_updated_at END
  FROM checks AS c
  WHERE p.id = c.id AND p.club_id = p_club_id
    AND c.checked_at IS NOT NULL;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION apply_dupr_rating_checks(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_dupr_rating_checks(uuid, jsonb) TO service_role;
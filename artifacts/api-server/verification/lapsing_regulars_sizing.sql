-- Lapsing regulars: sizing and baseline (READ-ONLY; changes nothing).
-- Paste into the production Supabase SQL Editor and run. Returns one table.
--
-- Definitions (proposed win-back flow, 2026-11-24):
--   visit       = a distinct (player, attended_at date) at PB Club.
--   regular     = 4+ visits in the 60 days ending on their last visit, with a
--                 measurable gap between visits (median gap over the prior 90 days).
--   overdue     = max(14, 2 x their median gap) days after the last visit,
--                 only if that is 30 days or less (the "lapsing" window).
--   trigger day = last visit + overdue days, when they had not come back by then.
--   came back   = any visit within 14 / 30 days after the trigger day, with no text.
--
-- Rows:
--   section = 'week'   one row per trigger week, last 26 weeks with 14+ days of follow-up.
--   section = 'total'  the same weeks combined (30-day figures use only weeks with 30+ days of follow-up).
--   Blank 30-day cells = not enough follow-up yet.
--   section = 'now'    players overdue today with no visit since (would be eligible now),
--                      split into textable (phone, not opted out) and all.
-- Caveat: attendances only holds past sessions, so this cannot see future bookings.
-- The live flow will check PodPlay for upcoming bookings and exclude those players.

WITH params AS (
  SELECT 'c8976e15-e002-4619-bb4b-b1a70f5cd7ab'::uuid AS club_id,
         (now() AT TIME ZONE 'America/New_York')::date AS today
),
data_end AS (
  SELECT max(a.attended_at) AS d FROM attendances a, params p
  WHERE a.club_id = p.club_id AND a.attended_at <= p.today
),
visits AS (
  SELECT DISTINCT a.player_id, a.attended_at AS d
  FROM attendances a, params p, data_end e
  WHERE a.club_id = p.club_id AND a.player_id IS NOT NULL AND a.attended_at <= e.d
),
gaps AS (
  SELECT player_id, d, d - lag(d) OVER (PARTITION BY player_id ORDER BY d) AS gap,
         lead(d) OVER (PARTITION BY player_id ORDER BY d) AS next_d
  FROM visits
),
habit AS (
  SELECT g.player_id, g.d, g.next_d,
    (SELECT count(*) FROM visits v WHERE v.player_id = g.player_id AND v.d BETWEEN g.d - 60 AND g.d) AS visits_60,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x.gap) FROM gaps x
      WHERE x.player_id = g.player_id AND x.d BETWEEN g.d - 90 AND g.d AND x.gap IS NOT NULL) AS median_gap
  FROM gaps g
),
triggers AS (
  SELECT h.*, greatest(14, ceil(2 * h.median_gap))::int AS overdue_days,
         h.d + greatest(14, ceil(2 * h.median_gap))::int AS trigger_d
  FROM habit h
  WHERE h.visits_60 >= 4 AND h.median_gap IS NOT NULL
    AND greatest(14, ceil(2 * h.median_gap)) <= 30
    AND (h.next_d IS NULL OR h.next_d - h.d > greatest(14, ceil(2 * h.median_gap)))
),
backtest AS (
  SELECT t.*
  FROM triggers t, data_end e
  WHERE t.trigger_d > e.d - 26 * 7 AND t.trigger_d <= e.d - 14
),
textable AS (
  SELECT p.id FROM players p, params x
  WHERE p.club_id = x.club_id AND nullif(btrim(p.phone), '') IS NOT NULL AND p.opted_out IS NOT TRUE
)
SELECT 'week' AS section, date_trunc('week', b.trigger_d)::date AS week_of,
       count(*) AS lapsing_regulars,
       count(*) FILTER (WHERE b.player_id IN (SELECT id FROM textable)) AS textable,
       count(*) FILTER (WHERE b.next_d <= b.trigger_d + 14) AS came_back_14d,
       round(100.0 * count(*) FILTER (WHERE b.next_d <= b.trigger_d + 14) / count(*), 1) AS pct_back_14d,
       CASE WHEN max(b.trigger_d) <= (SELECT d FROM data_end) - 30
            THEN count(*) FILTER (WHERE b.next_d <= b.trigger_d + 30) END AS came_back_30d,
       CASE WHEN max(b.trigger_d) <= (SELECT d FROM data_end) - 30
            THEN round(100.0 * count(*) FILTER (WHERE b.next_d <= b.trigger_d + 30) / count(*), 1) END AS pct_back_30d,
       round(avg(b.overdue_days), 1) AS avg_overdue_days
FROM backtest b GROUP BY 2
UNION ALL
SELECT 'total', NULL, count(*),
       count(*) FILTER (WHERE b.player_id IN (SELECT id FROM textable)),
       count(*) FILTER (WHERE b.next_d <= b.trigger_d + 14),
       round(100.0 * count(*) FILTER (WHERE b.next_d <= b.trigger_d + 14) / nullif(count(*), 0), 1),
       count(*) FILTER (WHERE b.next_d <= b.trigger_d + 30 AND b.trigger_d <= (SELECT d FROM data_end) - 30),
       round(100.0 * count(*) FILTER (WHERE b.next_d <= b.trigger_d + 30 AND b.trigger_d <= (SELECT d FROM data_end) - 30)
             / nullif(count(*) FILTER (WHERE b.trigger_d <= (SELECT d FROM data_end) - 30), 0), 1),
       round(avg(b.overdue_days), 1)
FROM backtest b
UNION ALL
SELECT 'now (data through ' || (SELECT d FROM data_end) || ')', NULL, count(*),
       count(*) FILTER (WHERE t.player_id IN (SELECT id FROM textable)),
       NULL, NULL, NULL, NULL, round(avg(t.overdue_days), 1)
FROM triggers t, params p
WHERE t.next_d IS NULL AND t.trigger_d <= p.today AND t.d + 30 >= p.today
ORDER BY 1 DESC, 2;

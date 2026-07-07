-- ============================================================
-- PROGRAM CATALOG 001 — Archetype Registry + Ratings Store
-- Run once in Supabase SQL Editor per environment.
-- Safe to re-run: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
-- ============================================================

-- 1. Extend programs table with catalog columns
ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS canonical_name         text,
  ADD COLUMN IF NOT EXISTS canonical_type         text CHECK (canonical_type IN ('open_play', 'clinic')),
  ADD COLUMN IF NOT EXISTS match_rules            jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS match_priority         int  NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS overrides_podplay_type boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_event_id        text,
  ADD COLUMN IF NOT EXISTS active                 boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at             timestamptz NOT NULL DEFAULT now();

-- 2. Unique constraint so seed is idempotent
ALTER TABLE programs
  ADD CONSTRAINT IF NOT EXISTS programs_club_canonical_uq
  UNIQUE (club_id, canonical_name);

-- 3. updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS programs_set_updated_at ON programs;
CREATE TRIGGER programs_set_updated_at
  BEFORE UPDATE ON programs
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- 4. program_ratings table
CREATE TABLE IF NOT EXISTS program_ratings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id           uuid        NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  club_id              uuid        NOT NULL REFERENCES clubs(id),
  daily_peak           boolean     NOT NULL,
  season               text        NOT NULL CHECK (season IN ('peak', 'off_peak')),
  fill_rate            numeric,
  event_count          int         NOT NULL DEFAULT 0,
  median_velocity_days numeric,
  new_player_share     numeric,
  modal_price_regular  numeric,
  modal_price_member   numeric,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, daily_peak, season)
);

-- 5. Permissions
GRANT SELECT, INSERT, UPDATE ON programs TO service_role;
GRANT SELECT ON programs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON program_ratings TO service_role;
GRANT SELECT ON program_ratings TO anon;

-- 6. Seed canonical archetypes for PB Club
--    ON CONFLICT (club_id, canonical_name) DO NOTHING → re-runnable.
--    To update match_rules, do a direct UPDATE; don't re-run this whole file.
DO $$
DECLARE
  v_club_id uuid := 'c8976e15-e002-4619-bb4b-b1a70f5cd7ab';
BEGIN

-- ── Priority 5: 60&60 — highest specificity; overrides PodPlay type ────────
INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, '60&60 Drill & Play', '60&60 Drill & Play', 'clinic', 5, true, true,
  '{"keywords":["60 & 60","60&60","drill session + guided","drill session + open"],"require_podplay_types":[]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

-- ── Priority 10: highly specific named archetypes ─────────────────────────
INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'DUPR Assessment', 'DUPR Assessment', 'clinic', 10, false, true,
  '{"keywords":["dupr assessment","need a dupr"],"require_podplay_types":["Clinics"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'Play With the Pro', 'Play With the Pro', 'clinic', 10, false, true,
  '{"keywords":["play with the pro","play with pro:"],"require_podplay_types":["Clinics"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'Queer Pickleball', 'Queer Pickleball', 'open_play', 10, false, true,
  '{"keywords":["queer"],"require_podplay_types":["Open Play"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'Ladies Open Play', 'Ladies Open Play', 'open_play', 10, false, true,
  '{"keywords":["ladies","galentine"],"require_podplay_types":["Open Play"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'DUPR-Tracked Open Play', 'DUPR-Tracked Open Play', 'open_play', 10, false, true,
  '{"keywords":["dupr tracked","dupr track"],"require_podplay_types":["Open Play"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

-- ── Priority 15: Challenge Court (before Coach-Guided to win on "King of the Court" overlap) ──
INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'Challenge Court Open Play', 'Challenge Court Open Play', 'open_play', 15, false, true,
  '{"keywords":["challenge court","king of the court","queen of the court","ladder play","ladder week","with prizes","winners stay"],"require_podplay_types":["Open Play"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

-- ── Priority 20: specific format archetypes ───────────────────────────────
INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'Coach-Guided Open Play', 'Coach-Guided Open Play', 'open_play', 20, false, true,
  '{"keywords":["instructional","coach guided","coach-guided","play with coach"],"require_podplay_types":["Open Play"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'Drill & Stay', 'Drill & Stay', 'open_play', 20, false, true,
  '{"keywords":["drill and stay","drilling / open play"],"require_podplay_types":["Open Play"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'Skills & Drills', 'Skills & Drills', 'open_play', 20, false, true,
  '{"keywords":["skills and drills","skills & drills","lunch time drilling","advanced drilling"],"require_podplay_types":["Open Play","Clinics"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'Learn to Play', 'Learn to Play', 'clinic', 20, false, true,
  '{"keywords":["learn to play","path to advanced beginner"],"require_podplay_types":["Clinics"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, '30&30 Drill & Play', '30&30 Drill & Play', 'clinic', 20, false, true,
  '{"keywords":["30 & 30","30&30"],"require_podplay_types":["Clinics"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'Path to Intermediate', 'Path to Intermediate', 'clinic', 20, false, true,
  '{"keywords":["path to intermediate"],"require_podplay_types":["Clinics"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'Workshop', 'Workshop', 'clinic', 20, false, true,
  '{"keywords":["workshop","pickleball iq","serving clinic","reset clinic"],"require_podplay_types":["Clinics"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

-- ── Priority 100: Social Open Play — catch-all for remaining Open Play ─────
INSERT INTO programs (club_id, name, canonical_name, canonical_type, match_priority, overrides_podplay_type, active, match_rules)
VALUES (v_club_id, 'Social Open Play', 'Social Open Play', 'open_play', 100, false, true,
  '{"keywords":[],"require_podplay_types":["Open Play"]}'::jsonb)
ON CONFLICT (club_id, canonical_name) DO NOTHING;

END $$;

-- 7. jobs row for program ratings nightly step
INSERT INTO jobs (id, status) VALUES ('program_ratings', 'idle')
ON CONFLICT (id) DO NOTHING;

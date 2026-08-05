-- Migration 005: Add event_name and podplay_type to event_fill
--
-- Purpose: Allows the backtest to apply keyword and podplay_types filters
-- from match_rules, which previously required event name / PodPlay custom
-- type that were not persisted in event_fill.
--
-- Run this in the Supabase SQL editor (service_role required).
-- After running, execute the backfill script to populate existing rows:
--   npx tsx src/scripts/backfillEventFillMetadata.ts

ALTER TABLE event_fill
  ADD COLUMN IF NOT EXISTS event_name   TEXT,
  ADD COLUMN IF NOT EXISTS podplay_type TEXT;

-- Grants (matching the blanket pattern from supabaseClient.ts)
GRANT SELECT ON TABLE event_fill TO anon;
GRANT ALL    ON TABLE event_fill TO service_role;

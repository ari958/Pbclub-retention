-- Player timing profile columns
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS avg_booking_lead_days  numeric,
  ADD COLUMN IF NOT EXISTS preferred_send_hour    int,
  ADD COLUMN IF NOT EXISTS timing_computed_at     timestamptz;

-- Scheduled send columns on messages
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS scheduled_send_at  timestamptz,
  ADD COLUMN IF NOT EXISTS send_strategy      text;

-- Permissions
GRANT SELECT, INSERT, UPDATE ON players  TO service_role;
GRANT SELECT, INSERT, UPDATE ON messages TO service_role;

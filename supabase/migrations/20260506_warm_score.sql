-- Warm score columns on players
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS warm_score             int,
  ADD COLUMN IF NOT EXISTS warm_score_updated_at  timestamptz;

-- Link strategy column on messages
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS link_strategy  text,
  ADD COLUMN IF NOT EXISTS link_clicked   boolean,
  ADD COLUMN IF NOT EXISTS ignored        boolean,
  ADD COLUMN IF NOT EXISTS reply_sentiment text;

-- Session type on attendances (populated by syncEventAttendance going forward)
ALTER TABLE attendances
  ADD COLUMN IF NOT EXISTS session_type  text;

-- Permissions
GRANT SELECT, INSERT, UPDATE ON players   TO service_role;
GRANT SELECT, INSERT, UPDATE ON messages  TO service_role;
GRANT SELECT, INSERT, UPDATE ON attendances TO service_role;

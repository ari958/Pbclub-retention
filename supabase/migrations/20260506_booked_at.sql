-- Real booking timestamp on attendances (from signup.summary.invitation.createdDate)
ALTER TABLE attendances
  ADD COLUMN IF NOT EXISTS booked_at timestamptz;

-- Extended timing profile on players
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS preferred_booking_dow   int,
  ADD COLUMN IF NOT EXISTS preferred_booking_hour  int,
  ADD COLUMN IF NOT EXISTS attendance_archetype    text;

-- Permissions
GRANT SELECT, INSERT, UPDATE ON attendances TO service_role;
GRANT SELECT, INSERT, UPDATE ON players     TO service_role;

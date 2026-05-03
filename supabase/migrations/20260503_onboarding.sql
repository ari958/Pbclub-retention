-- Onboarding columns for multi-platform support
-- Run this once in the Supabase SQL editor for your project.

ALTER TABLE clubs
  ADD COLUMN IF NOT EXISTS platform             text    NOT NULL DEFAULT 'podplay',
  ADD COLUMN IF NOT EXISTS platform_api_key     text,
  ADD COLUMN IF NOT EXISTS platform_org_id      text,
  ADD COLUMN IF NOT EXISTS cr_rating_category_id text,
  ADD COLUMN IF NOT EXISTS onboarded            boolean NOT NULL DEFAULT false;

-- Mark any existing clubs as already onboarded (they were set up before this flow existed)
UPDATE clubs
SET    onboarded = true,
       platform  = 'podplay'
WHERE  onboarded = false;

-- Confirm
SELECT id, name, platform, onboarded FROM clubs;

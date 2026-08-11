-- 009 — Reconcile contact_ledger schema drift (Phase 4.3 audit finding)
--
-- The deployed contact_ledger table drifted from 007_experiments.sql:
--   * `notes` (defined in 007) does NOT exist in the deployed database —
--     inserts that included it failed silently, which is why the ledger had
--     0 rows before the Phase 4.2/4.3 fixes. Application code no longer
--     writes `notes`; the canonical shape drops it.
--   * The deployed table has `outcome text` and `updated_at timestamptz`
--     columns that 007 never defined.
--
-- This migration is IDEMPOTENT and converges any database state (fresh 007
-- run or the drifted production table) to the deployed/canonical shape.
-- Running it against the current Supabase database is a no-op.
--
-- Run manually in the Supabase SQL editor (like 006/007/008).

ALTER TABLE contact_ledger DROP COLUMN IF EXISTS notes;
ALTER TABLE contact_ledger ADD COLUMN IF NOT EXISTS outcome    text;
ALTER TABLE contact_ledger ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

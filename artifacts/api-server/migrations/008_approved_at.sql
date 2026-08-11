-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008 — approved_at gate on programming_decisions
-- Run in Supabase SQL editor (service_role required).
-- Safe to re-run: all DDL uses IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Adds approved_at to programming_decisions so the operator can stamp
-- "I have reviewed this audience and approve the send" before any SMS
-- dispatch is enabled.  No Twilio call is made by this migration — it is
-- purely a schema gate.

ALTER TABLE programming_decisions
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

COMMENT ON COLUMN programming_decisions.approved_at IS
  'Operator approval timestamp. NULL = not yet approved. SET = operator has reviewed the ranked audience and approved the send gate.';

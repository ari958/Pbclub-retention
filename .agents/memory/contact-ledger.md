---
name: Contact ledger
description: Phase 3.4 decisions — contact_ledger table, budget gate, recency tiebreaker, pool size constraints
---

## contact_ledger table
Migration 007 (migrations/007_contact_ledger.sql) — needs manual run in Supabase SQL editor.
Columns: id, club_id, player_id, source, purpose (promotion/cancellation/other), channel, decision_id, sent_at, outcome.
Index on (club_id, player_id, sent_at DESC) for hot budget queries.

**Cancellation exemption:** purpose='cancellation' rows are stored for visibility but NEVER used in budget logic. Budget queries always filter `purpose='promotion'`. This is enforced in step 7b of the promotion candidates builder.

## contact_budget in programming_rules
Column `contact_budget` (jsonb) added to programming_rules in migration 007.
Default: `{"cooldown_days": 7, "max_per_30_days": 2, "applies_to": ["promotion"]}`.
Code falls back to these defaults if the column is null (pre-migration state).

## Recency tiebreaker weights
- never contacted → +15
- > 30 days since last promotion → +8
- 15–30 days → +3
- < 15 days (but outside cooldown) → 0
- within cooldown → EXCLUDED (never reaches tiebreaker)

**Why:** warm score contributes ×10 (range −30 to +40), so recency at max +15 is a meaningful tiebreaker between adjacent-score candidates without overriding warm-score separation.

**How to apply:** computed post-loop after warm score, in the 8c block. `reasons.base_score` = score before recency; `reasons.recency_adjustment` = delta; `reasons.recency_basis` = "never_contacted" or "Xd_since_contact".

## Pool size vs send cadence
**Critical constraint:** 24 SMS-reachable early/planner players at PB Club (as of 2026-08-07). Budget allows max 2 promotions per player per 30 days = 48 total sends on the current pool per month.

Simulation results (10 clinics, 3 sends each):
- 30 total sends
- 22 distinct players reached
- min=1, median=1, max=2 contacts per player
- 0 decisions exhausted the pool

At 24 sends/clinic (spec assumption): pool exhausts after ~2 clinics. The pool CANNOT support 10 × 24 sends.

**Recommendation:** send to top 3–5 SMS-reachable per clinic. At 5/clinic × 10 clinics = 50, barely above the 48-send budget limit. At 3/clinic, the pool holds for the full month.

To expand the pool: loosen archetype gate (default → penalty) or widen 180d/min=2 to all-time/min=1. The lever with least risk: increase max_per_30_days to 3 while keeping the archetype gate strict.

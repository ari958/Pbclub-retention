---
name: Phase 3.5 findings
description: Buddy signal fix, open play backtest results, send volume policy, key schema discoveries
---

# Phase 3.5 Findings

## Buddy signal fix
- **Root cause**: `signedUpPlayerIds` was built from `attendances` filtered by `event_id`, which is always empty for upcoming events (attendances = past events only)
- **Fix**: resolve `bookedExternalIds` (PodPlay external IDs, already fetched live) → internal UUIDs via `players.external_id`
- **Verified**: 4 buddy hits on synthetic PROMOTE decision (inc. #1 Emily Cubilete buddy×2, score=100)
- **buddy_pairs table**: 833 rows, NO `club_id` column — queries must NOT filter by club_id (returns 0 falsely if you do)
- **Hit rate**: sparse — 4/1,594 eligible on one session. Treat as bonus signal, not core.

## Open play backtest (T-6h, 120 days, 222 evaluated events, ±17pp uncertainty)
Absolute count:
- N=4: 56% fire, 52% prec | N=5: 67%/59% | N=6: 77%/65% | N=7: 86%/75% | N=8: 89%/79% | N=10: 93%/86%

Fill ratio:
- 25%: 36%/21% | 33%: 46%/40% | 40%: 54%/48% | 50%: 58%/47% | 60%: 74%/60%

Capacity bands (N=6):
- Small ≤6: 90% fire, 83% prec | Medium 7–12: 73%/63% | Large 13+: 64%/28%

**Recommendation**: N=7/T-6h — better precision than N=6 (75% vs 65%), within ±17pp band
**Large-session caveat**: N=7 still has poor precision for 13+ team sessions — capacity-aware threshold is a future improvement

Rule updated: `01cea5a1` "Open Play — cancel + promote", PROMOTE checkpoint added N=7/T-6h

## Send volume policy
- `max_sends_per_decision` added to ContactBudget interface + BUDGET_DEFAULTS (25)
- Default 25 applies to both clinic and open play until migration 007 runs and per-rule tuning is done
- Intended: clinics=25, open play=40 (requires migration 007 + contact_budget update on rules)
- Simulation (10 decisions, 5 clinic×25 + 5 open play×40): 325 sends, 325 distinct players, 17% of budget
- All decisions fully served; no decision ran short

## Open play PROMOTE rule
- Was never seeded in Phase 3 despite session notes saying it was
- id=01cea5a1 had only a CANCEL checkpoint; PROMOTE was missing
- Added: N=7/T-6h PROMOTE checkpoint; rule renamed to "Open Play — cancel + promote"

## Key schema discoveries
- `buddy_pairs` has NO `club_id` column — always query without club_id filter
- `programming_decisions`: synthetic test decision `743053a0` has no row in this table (was created directly in promotion_candidates for testing)
- migration 007 (contact_budget column on programming_rules) still pending — contact_budget uses code defaults only until then

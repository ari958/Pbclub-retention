---
name: Level-gated events excluded from outreach
description: Operator policy — events with a PodPlay admissionRating min or max are excluded from ALL outreach; simulated dispatches tracked via reasons.dispatch_simulated
---

**Rule:** Any event with `admissionRating.minRating` OR `maxRating` set is excluded from outreach entirely — experiment candidates, promotion candidates, dispatch, and mark-sent all block it.

**Why:** Operator directive (Aug 2026): never invite a below-level player to a level-gated event. PodPlay admission ratings are DUPR-scale (e.g. 3.75); player levels are word tags on a 1–5 scale and null for ~99% of players — eligibility cannot be verified, so the whole event is out until real player DUPR data exists.

**How to apply:** Enforced at candidate build (experiments + promotion), preview (pool 0 + note), create (422), dispatch and mark-sent (recheck via PodPlay fetch, fails CLOSED if unreachable). If adding a new outreach path, add the same gate. Old bug: gate required BOTH min AND max non-null, so min-only events were never filtered.

**Simulated sends:** `SMS_LIVE=false` dispatches set `reasons.dispatch_simulated=true` on the participant row (no ledger row written; excluded from measurement, completeness rollup, and pooled results; amber badge in UI). No dedicated column — flag lives in the reasons JSON.

**Related bugs fixed same session:** contact_ledger inserts had silently failed forever (nonexistent `notes` column + swallowed errors) — ledger errors now logged loudly; Express route ordering — literal routes like `/experiments/pooled-results` must be registered before `/experiments/:id`.

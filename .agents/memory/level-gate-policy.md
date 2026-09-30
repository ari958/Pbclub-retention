---
name: Legacy level-gated outreach policy
description: Boundaries between legacy event promotion and the explicitly approved retention phase
---

**Rule:** In legacy experiment/promotion outreach, any event with `admissionRating.minRating` OR `maxRating` set is excluded — candidates, dispatch, and mark-sent all block it.

**Why:** Operator directive (Aug 2026): never invite a below-level player to a level-gated event. PodPlay admission ratings are DUPR-scale (e.g. 3.75); player levels are word tags on a 1–5 scale and null for ~99% of players — eligibility cannot be verified, so the whole event is out until real player DUPR data exists.

**How to apply:** Preserve this restriction in the parked legacy paths. Min-only and max-only admissions both count; requiring both misses gated events.

**Approved retention phase:** Do not silently carry every legacy audience/event gate into this phase. Follow the current retention specification and rollout instructions instead.

**Why:** The 2026-09-30 specification explicitly defines this phase's eligibility and fixed suggested-program list, with per-message human review. Reintroducing old gates would change the requested cohort or suggestion selection without instruction.

**How to apply:** Keep the legacy restriction intact when editing experiments/programming. If additional admission filtering is desired for retention drafts, obtain a new requirement rather than treating the old blanket wording as authorization.

**Simulated sends:** `SMS_LIVE=false` dispatches set `reasons.dispatch_simulated=true` on the participant row (no ledger row written; excluded from measurement, completeness rollup, and pooled results; amber badge in UI). No dedicated column — flag lives in the reasons JSON.

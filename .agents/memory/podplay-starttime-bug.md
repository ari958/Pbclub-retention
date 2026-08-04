---
name: PodPlay startTimeTo bug
description: PodPlay events API startTimeTo does not enforce UTC boundaries strictly
---

## Rule
Always apply a client-side `new Date(e.startTime) > now` (or `< now` for past events) filter after any PodPlay events API call that uses `startTimeTo` or `startTimeFrom`.

**Why:** The PodPlay `startTimeTo` parameter does not enforce UTC boundaries precisely. A query with `startTimeTo=2026-08-01T01:34:40Z` returned Aug 1–28 future events, not just events before the cutoff. This caused a "91 configured past events" false finding in an earlier investigation — all of those events were actually future events.

**How to apply:** In any code that queries `/events?startTimeTo=X`, apply BOTH bounds client-side: `new Date(e.startTime) > now && new Date(e.startTime) <= horizon`. See `programmingEvaluator.ts` `fetchUpcomingEvents()` — upper-bound filter was added in Phase 2.1 after the evaluator was returning 237+ events instead of the intended 43 within 96h.

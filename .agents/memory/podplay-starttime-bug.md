---
name: PodPlay startTimeTo bug
description: PodPlay events API startTimeTo does not enforce UTC boundaries strictly
---

## Rule
Always apply a client-side `new Date(e.startTime) > now` (or `< now` for past events) filter after any PodPlay events API call that uses `startTimeTo` or `startTimeFrom`.

**Why:** The PodPlay `startTimeTo` parameter does not enforce UTC boundaries precisely. A query with `startTimeTo=2026-08-01T01:34:40Z` returned Aug 1–28 future events, not just events before the cutoff. This caused a "91 configured past events" false finding in an earlier investigation — all of those events were actually future events.

**How to apply:** In any code that queries `/events?startTimeTo=X`, add `.filter(e => new Date(e.startTime) < cutoff)` (or `> now` for upcoming) immediately after receiving the response items. See `programmingEvaluator.ts` `fetchUpcomingEvents()` and the forward-risk analysis scripts for examples.

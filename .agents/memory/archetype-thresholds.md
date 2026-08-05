---
name: Archetype thresholds and warm score
description: Phase 3.3 decisions — 180d/min=2 threshold, warm score programType fix, buddy signal root cause
---

## Archetype threshold: 180-day window, minimum 2 qualifying rows
**Why:** 334 players had 1–2 qualifying rows in the 90d window — these are real monthly members who can't clear a 3-row bar. 180d/min=2 captures their long-term booking patterns. Stability check: 12.2% disagreement rate, mostly late↔mid shifts within the excluded zone. early+planner grows from 36 to 124 (cluster at 40 active engagement).

**How to apply:** Both `computePlayerTiming` and `batchComputePlayerTiming` in `playerTiming.ts` use 180d window and `valid.length < 2`. The batch Step 9 in the nightly chain recomputes stale entries (>22h). After Phase 3.3: early=62, mid=121, late=144, planner=62, default=2117 across 2,506 players.

## Warm score: programType must come from event_fill OR rule_name fallback
**Why:** `event_fill.podplay_type` is null until migration 006 + backfill runs. Passing null/empty programType to `computeWarmScore` previously caused the `-2 never-attended-type` penalty to always fire (the `programType && !hasAttendedType` check was `!hasAttendedType` — always true when programType is falsy). Fixed in warmScore.ts.

**How to apply:** In the promotion candidates builder, derive programType: `fillRow?.podplay_type ?? (ruleName.includes("Clinic") ? "Clinics" : ruleName.includes("Open Play") ? "Open Play" : null)`. warmScore.ts now only penalizes when `programType && !hasAttendedType` — unknown programType is treated as a knowledge gap, not non-attendance.

## Warm score: skipCache=true in promotion builder
**Why:** warm_score in `players` table is a player-level cache, not event-class-specific. The promotion builder computes event-specific scores that must not overwrite the player cache. `skipCache=true` option added to `WarmScoreOptions` in warmScore.ts.

**How to apply:** Always pass `{ skipCache: true }` when calling `computeWarmScore` from the promotion candidates builder. Scores stored in `reasons.warm_score_built` + `reasons.warm_score_program_type`.

## Buddy signal: cannot fire for future events
**Why:** `signedUpPlayerIds` comes from `attendances.event_id == eventId`. The sync only fetches past events (startTimeTo=now). Future clinics have 0 attendance rows → buddy map is always empty.

**How to apply:** Fix (deferred): convert `bookedExternalIds` (already fetched from PodPlay at step 3 in the promotion candidates builder) to internal player IDs via an external_id → id lookup, then use those for the buddy map. The join logic itself is correct.

## Archetype distribution after 180d/min=2
early: 62, mid: 121, late: 144, planner: 62, default: 2117 (2,506 total)
early+planner: 124 total; 40 pass both engagement AND archetype gates for decision 743053a0.

## Default as ranking penalty (not implemented)
If `default` archetype were a ranking penalty instead of hard gate: 1,259 eligible (all post-engagement) vs 40 (current). Not recommended for T-18h outreach — default means "we don't know their booking window", which makes T-18h targeting unreliable. Keep as gate.

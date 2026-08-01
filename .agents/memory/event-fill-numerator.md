---
name: Event-fill numerator fix
description: signups._total vs active-count error quantification and fix applied Aug 2026
---

## Rule
Use active signup count (PENDING + CONFIRMED) from `GET /events/{id}/signups` as the `final_signups` numerator in `event_fill`, NOT `signups._total` from the event detail endpoint.

**Why:** `signups._total` includes CANCELED/INVALID/DRAFT signups. Measured error in a 25-event sample: mean=0.3, p50=0, p90=1, max=4. Small but non-zero.

**How to apply:** `fetchActiveSignupCount()` in `eventFillSync.ts` (also exported from `programmingEvaluator.ts`) calls the `/events/{id}/signups` endpoint and filters. This adds one extra API call per event in the fill sync — acceptable for nightly incremental (~15 events) and manageable for full backfill (~774 events, ~2.5min at 200ms sleep).

## Key finding
The earlier spec claimed "median gap 5, max 22" — that was comparing `signups._total` to our **attendance rows** (biased member-subset), NOT to the PodPlay active signup count. The actual `_total` vs active-count error is near-zero.

## Backfill
`POST /api/programming/backfill-fill` with `{ clubId, dryRun: true }` re-fetches all existing `event_fill` rows. Run dry-run first; only ~5/25 rows change in sample.

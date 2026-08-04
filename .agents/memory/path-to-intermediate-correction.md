---
name: INVALID signup status — series clinic enrollments
description: INVALID status in PodPlay signups represents real participants for series/package clinic events; must NOT be excluded from active counts
---

## Rule
The INACTIVE exclusion set for signup counting must be `{CANCELED, DRAFT}` only. Do NOT include `INVALID`.

**Why:** PodPlay's Path to Intermediate "series pass" clinic enrollments land in `INVALID` status rather than `CONFIRMED`. Local attendance rows confirm real participation: all 22 zero-count P2I events had 1–3 attendance rows each, but zero active count when INVALID was excluded. Removing INVALID from the exclusion set restores P2I median to 4 (matching original `signups._total`) and reduces the backfill change rate from 36.5% to 6.4%. CANCELED is the correct signal for a withdrawn booking; DRAFT is an incomplete entry; INVALID maps to "series clinic fulfilled enrollment."

**How to apply:** In `eventFillSync.ts` and `programmingEvaluator.ts`, the INACTIVE set is `new Set(["CANCELED", "DRAFT"])`. Do not add INVALID back under any circumstances — it would break P2I and all series-style clinic counts. Single-session clinics (Learn to Play, Workshop) naturally reach CONFIRMED and are unaffected by this distinction.

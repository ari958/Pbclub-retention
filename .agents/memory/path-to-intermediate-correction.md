---
name: Path to Intermediate fill correction finding
description: Backfill corrected Path to Intermediate median from 4→0; this is correct data, not overcorrection
---

## Rule
If event_fill shows a sudden drop in Path to Intermediate signups/fill to near-zero, it is correct. The pre-backfill data was counting cancelled signups.

**Why:** Phase 2.1 fill backfill revealed that 22 of 41 Path to Intermediate events had `final_signups=0` after correcting to active count (excluding CANCELED/INVALID/DRAFT). The stored `signups._total` value was 4 for most of those rows (capacity=4), but all 4 signups had been cancelled — likely because the Path to Intermediate program was run during a period with high cancellation rates. The backfill median moved 4→0 (exceeds the ~1 threshold), but investigation confirmed this is genuine correction, not an artifact.

**How to apply:** Do not revert or flag this archetype's zeros as data quality issues. The zeros are accurate active-participant counts. When computing medians for model inputs, Path to Intermediate should be treated as a low-attendance archetype (median=0, meaning most sessions ran with 0-1 active participants after cancellations).

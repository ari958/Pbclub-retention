---
name: Evaluator decisions timing
description: Shadow evaluator writes 0 decisions until events enter their checkpoint window; this is expected
---

## Rule
The evaluator writes decisions only when `cp.offset_hours >= hoursUntilStart` — i.e., when the event is within `offset_hours` of its start time. Running the evaluator outside this window produces 0 decisions, which is correct.

**Why:** The seeded baseline rule has `offset_hours: 3`. Off-peak events are typically scheduled 8–16h in advance, so running the evaluator during a period with no events within 3h produces 0 decisions. The first decisions will be written around 7:00–8:00 AM EDT when the morning off-peak sessions (starting at 11:00 AM ET) enter their 3h window.

**How to apply:** To get the first real decisions, run the evaluator after ~07:00 AM ET on a day with off-peak Open Play events. The idempotency test (second run = 0 new rows) can only be properly verified after at least one decision has been written. After the first run with decisions, re-run immediately — decisions_written must equal 0 on the second run.

## Evaluator returns 43 events at 96h window
After the client-side horizon fix, the evaluator correctly returns ~43 events in the 96h window (previously would return 237+ due to PodPlay ignoring startTimeTo). This is the expected baseline for PB Club.

---
name: Coupon call measurement
description: Limits of retrospective sync cost comparisons when HTTP telemetry was not retained.
---

Do not present current PodPlay signup/order reads or attendance upsert counts as an exact historical HTTP-call measurement.

**Why:** A nightly job retained event/signup/upsert totals but no order/coupon counters. Its event total included empty sessions, canonical attendance rows were fewer than upserts, and current live signups did not reproduce the original matched count.

**How to apply:** Prefer recorded per-run resource counters. Label retrospective replay or upper bounds explicitly and stop claiming an exact comparison when the reconstructed cohort differs. This limitation does not block implementing the run-local cache or existing-row lookup exclusion.

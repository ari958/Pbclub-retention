---
name: PodPlay context rate limits
description: Sequential retention context rebuilds can exceed PodPlay signup-read limits.
---

Treat PodPlay signup rate limits as a batch-level constraint, not merely a per-candidate issue. Keep rate-limit failures explicit and fail closed.

**Why:** A sequential ten-candidate regeneration repeatedly scanned the same upcoming events and signup endpoints. The first context reads succeeded, but later candidates received HTTP 429 despite sequential candidate processing.

**How to apply:** When improving context retries or batch regeneration, share successful live snapshots within a bounded batch, pace requests, and honor retry guidance. Do not convert 429 into empty signup lists or reuse failed reads as successful context.

PodPlay's `_total` can describe the current response page, not the whole query. Do not treat it as a reliable global pagination total.

**Why:** A live multi-page event query returned a nonzero `_total` on its populated first page and zero on its empty second page. Confusing those values with global totals can truncate full-coverage booking checks.

**How to apply:** Use explicit global pagination information when supplied, and the effective `_pagination.ipp` when deciding whether a page is short. Keep pagination exhaustion or malformed metadata fail-closed.
---
name: PodPlay context rate limits
description: Sequential retention context rebuilds can exceed PodPlay signup-read limits.
---

Treat PodPlay signup rate limits as a batch-level constraint, not merely a per-candidate issue. Keep rate-limit failures explicit and fail closed.

**Why:** A sequential ten-candidate regeneration repeatedly scanned the same upcoming events and signup endpoints. The first context reads succeeded, but later candidates received HTTP 429 despite sequential candidate processing.

**How to apply:** When improving context retries or batch regeneration, share successful live snapshots within a bounded batch, pace requests, and honor retry guidance. Do not convert 429 into empty signup lists or reuse failed reads as successful context.
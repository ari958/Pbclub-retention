---
name: Run-history boundaries
description: Observability must remain optional; generation history counts intentionally include prefilter outcomes.
---

Run history is observability, not an execution prerequisite. Missing history tables or logging failures must not block generation, sync, approvals, or sending. Keep history-read failures explicit rather than returning invented empty success.

**Why:** The user requested recording and display without changing outreach or job behavior, and required stopping before installing the history schema.

**How to apply:** Do not make optional history availability a critical startup or generation readiness gate. Preserve the original operation's results and failure handling while reporting unavailable history separately.

History's evaluated/skipped totals include players observed in the first-attendance scan, including out-of-window prefilters. Existing generation-result counters keep their previous narrower meaning.

**Why:** The requested per-player reasons explicitly include players outside the Learn to Play window, while the old generator did not count those prefilter skips. Changing its counters was deliberately avoided.

**How to apply:** Do not assume history counts must equal legacy result counters. When explaining totals, distinguish observed player outcomes from legacy matched-candidate statistics.

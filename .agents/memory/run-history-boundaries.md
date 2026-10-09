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

An empty newly installed history is not proof that an earlier nightly sync did not run. Monitoring rollout must distinguish absent observation from absent completion.

**Why:** A sync completed before the history-enabled deployment, but its empty new history produced an incorrect missed-completion alert and dashboard statement. The existing job record and completion logs proved the sync finished on time.

**How to apply:** Corroborate missing history with existing job completion evidence during rollout. Do not invent historical per-step details or rerun a completed sync merely to populate history.

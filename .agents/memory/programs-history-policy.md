---
name: Programs history policy
description: Why active programming screens separate current work from historical records.
---

Keep passed programs out of active views and expose them separately in Archive. Preserve original decision and experiment records, including lifecycle statuses, instead of deleting them or rewriting statuses just to remove them from the active dashboard.

**Why:** The user explicitly wants current data by default across Programs tabs. Historical experiments and decisions are still needed for audit and outcome analysis; their saved status is distinct from whether an event is in the past.

**How to apply:** Treat event start time as the boundary for promotion work: after it starts it is no longer an upcoming outreach opportunity. Apply that boundary to lists, pagination, selected details, and periodic refreshes. Use live upcoming events as the default view; do not equate UI polling with recalculating saved programming decisions.

## Go-live reset preservation

The go-live clean slate is archival, not destructive: archive old unsent messages, skip old non-sent retention candidates, and release their capacity reservations. Preserve sent history, existing opt-out flags, STOP/opt-out records, the contact ledger, and audit tables. Do not approve, send, or change live sending settings as part of the reset.

**Why:** The user explicitly required these boundaries for the pre-launch reset.

**How to apply:** Verify the protected records before and after refresh operations. Attendance refresh must not rewrite sent-message conversion attribution during this reset. Skipping an old candidate is not permission to erase or broadly bypass its duplicate-prevention history.

The user authorized a narrow replacement exception for reset-skipped candidates whose messages were archived and never approved, dispatched, or sent. Preserve the original records and re-run current eligibility and live context checks; do not treat other skipped candidates or previously sent sequences as restartable.

**Why:** The archival reset otherwise prevented the three recent Learn to Play attendees from receiving fresh unapproved drafts.

**How to apply:** Keep the exception explicit and reset-specific. Link retained history to the replacement instead of deleting records, reactivating old messages, or erasing delivery evidence.
---
name: LTP test recovery policy
description: User-selected recovery semantics and destination proof for override-only LTP test sends.
---

Recover an unbooked test recipient by archiving the complete original test sequence/candidate history and resetting the same live sequence in place. Preserve uniqueness rules, conflict targets, and message rows. Keep historical test contact out of caps without deleting its evidence.

**Why:** The user explicitly chose additive test-history archival plus an in-place reset so the normal approval-only pipeline can draft a fresh step one without loosening lifetime identity rules.

**How to apply:** First check attendance and complete live upcoming signups. Skip recovery for genuinely booked players; distinguish a test-simulated booking from a real one. Keep the archive marked as test history without marking the reset live root as test solely because it has an archive. A recovery proposal is not authorization to apply it, draft, approve, or send.

Test-clock changes require the configured override and proof that every actual sent message went to that override. Current player phones and test flags are not destination evidence.

**Why:** The user required stored destinations, not inferred test status, as the boundary protecting actual player sends.

**How to apply:** Verify actual provider-stored outbound records when local rows have no destination. Fail closed on incomplete, unavailable, or mismatched evidence; log use and refusal with the sequence and operator.

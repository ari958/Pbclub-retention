---
name: LTP test recovery policy
description: User-selected recovery semantics and destination proof for override-only LTP test sends.
---

For the four stranded override-test recipients, archive the complete original history and terminally close the existing sequences as `exited_test` with reason `test_override_sends`. Do not reset or redraft them. Retain blocked step candidates, uniqueness rules, conflict targets, message rows, and test-contact evidence.

**Why:** The user replaced the reset proposal with terminal closure after confirming the old LTP dates would not qualify for normal step-one generation.

**How to apply:** Preserve original archive snapshots and the existing audit view; do not append archive rows to that view. For this four-root close only, use expected-state and exact linked-message/provider-proof checks, not attendance checks or app session-setting gates. Do not update contact-ledger rows. Clear simulated booked-exit fields on live roots and candidates, not on immutable snapshots. Keep actual test send evidence. A written closure proposal is not authorization to apply it, draft, approve, or send.

Test-clock changes require the configured override and proof that every actual sent message went to that override. Current player phones and test flags are not destination evidence.

**Why:** The user required stored destinations, not inferred test status, as the boundary protecting actual player sends.

**How to apply:** Verify actual provider-stored outbound records when local rows have no destination. Fail closed on incomplete, unavailable, or mismatched evidence; log use and refusal with the sequence and operator.

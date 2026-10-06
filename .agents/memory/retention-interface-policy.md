---
name: Retention interface policy
description: Product intent behind the approval-only rollout and preservation of legacy features.
---

Treat the retention rollout as an intentionally approval-only operator workflow. Preserve legacy implementations for the other modes instead of treating hidden features as permission to delete them.

**Why:** The user explicitly requested that Approvals be the only path to creating or sending retention texts, while legacy features are hidden or parked conditionally rather than deleted. The reduced interface is a product boundary, not merely a visual cleanup.

**How to apply:** Future retention work should not reintroduce independent drafting/sending controls or background requests for hidden features. Keep frontend visibility and backend authorization as separate decisions; retaining a legacy implementation does not grant it permission to send in the retention rollout.

For the Learn to Play rollout, present each actual draft's full text alongside its context to the user before approving any messages or starting live delivery testing.

**Why:** The user reserved review of voice, factual accuracy, the offer, and the next-program suggestion before the live test. A request to generate drafts is not permission to enable sending or approve them.

**How to apply:** Keep draft-only runs separate from approval and sending-setting changes. Wait for the user's review before the live-test phase, and use a test number the user controls; the assistant has no phone number.

New nightly-generated LTP first-touch candidates are real outreach candidates, not delivery-test records.

**Why:** The user explicitly said these new candidates “are real first-touch candidates and must not be used for testing.”

**How to apply:** Limit delivery-retest preparation to the explicitly selected existing test cohort. Report new first-touch candidates read-only; do not approve, regenerate, or change them during that test work.

For accelerated LTP step-2 tests, backdate only an effective eligibility clock, not the original sent message or real-delivery classification. Booking and attendance checks still start at the actual step-1 send time.

**Why:** The user requested accelerated test eligibility without changing real-mode eligibility. Moving the booking cutoff backward would incorrectly treat activity before delivery as a response to step 1.

**How to apply:** Keep test controls explicitly override-gated and separate from real eligibility. Do not shorten the shared gap, recategorize test sends as real, or rewrite historical send evidence.

Treat permission to sync PodPlay phone numbers as contact-data permission only, not permission to infer SMS consent or change sending eligibility settings. Preserve existing numbers, opt-outs, and affirmative-consent evidence.

**Why:** The user authorized contact synchronization to unblock draft review while retaining the draft-only boundary. Having a phone number does not establish consent, and a legacy importer previously coupled phone availability to opt-in.

**How to apply:** Keep phone-only synchronization separate from consent imports and approval/send actions. Verify consent and opt-out fields are unchanged across a contact sync.

Do not automatically substitute a similarly named, higher-level program when the configured Learn to Play next-program titles are absent.

**Why:** Title normalization fixes case, dash, and whitespace differences; it cannot establish that a different program is appropriate for a new player. The live audit found a higher-level title with an extra word, not a formatting mismatch.

**How to apply:** Preserve the configured program choices. After a successful live no-match, use the user-approved generic thank-you/offer fallback without a program suggestion; lookup failures still need context. Obtain an operator decision before adding semantic aliases or changing recommended programs.

The no-program fallback still acknowledges attendance at Learn to Play with the supplied date phrase. It is not a generic club-membership thank-you.

**Why:** The user corrected the generic fallback because it lost the reason for the outreach. “No program” means no next-program suggestion, not removal of the verified past attendance fact.

**How to apply:** Preserve the specific attendance thank-you and its verified timing when refining the fallback. The exception does not authorize other program suggestions, dates, or classmates.

Preserve the original batch's lookback provenance when reprocessing legacy drafts. Missing per-candidate metadata is not evidence that the batch used the current production default.

**Why:** Legacy drafts predated lookback metadata. Defaulting those rows to three days during regeneration incorrectly removed their known longer-window test flags.

**How to apply:** Use the documented batch response or explicit operator input for the source window, rather than inventing it from the current default. Keep provenance-only corrections separate from message, approval, and send fields.
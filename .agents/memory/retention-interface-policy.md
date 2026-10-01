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
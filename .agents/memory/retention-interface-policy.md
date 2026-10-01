---
name: Retention interface policy
description: Product intent behind the approval-only rollout and preservation of legacy features.
---

Treat the retention rollout as an intentionally approval-only operator workflow. Preserve legacy implementations for the other modes instead of treating hidden features as permission to delete them.

**Why:** The user explicitly requested that Approvals be the only path to creating or sending retention texts, while legacy features are hidden or parked conditionally rather than deleted. The reduced interface is a product boundary, not merely a visual cleanup.

**How to apply:** Future retention work should not reintroduce independent drafting/sending controls or background requests for hidden features. Keep frontend visibility and backend authorization as separate decisions; retaining a legacy implementation does not grant it permission to send in the retention rollout.
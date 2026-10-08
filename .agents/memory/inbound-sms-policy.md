---
name: Inbound SMS handling policy
description: Unknown and ambiguous sender handling, STOP retention, and tenant identity.
---

Retain unknown inbound messages, including STOP, as club-scoped messages with no player link. Show “Unknown sender” in Replies and queue an operator alert.

**Why:** The user explicitly requested this instead of silently discarding unknown messages.

**How to apply:** Preserve the sender, destination, original text, receipt time and provider identity so a later match remains possible. Do not infer consent or approve/send anything when capturing a receipt.

Never select an arbitrary player when a canonical phone matches multiple records. Treat that match as ambiguous and leave it unlinked.

**Why:** Same-club duplicate phone records were encountered during production diagnosis; selecting the first could pause the wrong sequence or alter the wrong consent record.

**How to apply:** Match within the webhook's explicitly assigned tenant, not across all players. The legacy unscoped webhook is bound to the configured default club; another club needs a signature-covered explicit routing parameter.

Keep raw unlinked receipts private rather than relying on a player relationship for access control.

**Why:** An unknown sender has no player relationship through which to establish ownership.

**How to apply:** Operator-authenticated, club-scoped reads only. Do not apply blanket anonymous grants to private inbox tables.

The user confirmed the fresh inbound reply worked after guidance to publish and configure the Messaging Service to “Defer to sender’s webhook,” using the phone number’s production inbound endpoint.

**Why:** A correct phone-number webhook alone does not establish that its Messaging Service routes inbound messages to it.

**How to apply:** When investigating missing inbound messages, inspect both service-level routing and the number-level webhook. Preserve this confirmed routing approach unless the user requests a change; do not infer that operator alerts or all STOP/sequence behaviors were verified by this confirmation.

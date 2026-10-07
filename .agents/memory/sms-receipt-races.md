---
name: SMS receipt races
description: Safety boundaries when provider callbacks arrive before submission responses.
---

Keep provider acceptance bookkeeping separate from delivery evidence. An early failure does not mean the dispatch claim was lost; an early delivered receipt alone does not prove an approved member delivery milestone.

**Why:** Twilio can call back before its submission response returns. Treating acceptance as a pending-to-sent update can erase or reject an already recorded receipt. Redirected member tests must never become real recipient deliveries.

**How to apply:** Correlate early callbacks to the persisted claim under the validated provider signature. Correlation is not authorization: retain all player, candidate, and sequence approval checks. Classify redirected tests before transport, preserve any existing callback receipt during acceptance writes, and require persisted acceptance plus a non-test recipient ledger before recording real delivery.

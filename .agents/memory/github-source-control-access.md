---
name: GitHub source-control access
description: Active source-control connection metadata is not proof that workspace Git can authenticate.
---

Verify actual repository access before claiming a GitHub sync is possible or complete. An active account connection alone is insufficient.

**Why:** The source-control integration reported healthy while workspace Git could not authenticate. Its reconnect prompt also rejected the connection, and the standard connection prompt rejected the provider-specific connection format.

**How to apply:** Confirm remote access before pushing. If provider-specific connection prompts are unavailable, use the Git pane's account/repository authorization flow rather than repeating failed prompts. Never force-push or claim files were synced when authentication failed.

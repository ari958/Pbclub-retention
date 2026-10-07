---
name: Operator alert incident policy
description: Single-worker ownership and shared incident alerts, including the external-provider claim tradeoff.
---

Exactly one process may run background jobs against this project's shared external database.

**Why:** The user explicitly required one background worker while investigating duplicate operator alerts. A per-job mutex does not prevent different processes from performing the same periodic task sequentially.

**How to apply:** Use one renewable global owner for all background work, retain per-job exclusion, and fail-stop on renewal loss. Fence older worker binaries as well as new contenders; do not assume all copies of the application have been upgraded. Preserve developer SMS-disable and operator pause settings during investigations.

The API and watchdog must share stable condition identities. Send at most one alert per incident and one resolved notification on clear; a later recurrence is a new incident.

**Why:** Identical kill-switch notifications came from an immediate API path and a next-minute watchdog path with different deduplication keys, even without evidence of a second active worker. Timestamp/date keys and local cooldowns cannot enforce shared incident semantics.

**How to apply:** Store state and atomic notification claims in the shared database. Preserve sender identity, producer source, provider SID and execution provenance. Do not invent historical sender or job counts where old telemetry lacks them.

Reserve the incident phase before submitting to Twilio and never automatically retry an ambiguous submission.

**Why:** Database state and Twilio cannot commit atomically. Choosing at-most-one submission prevents duplicate alerts, but a sender crash can leave an unsent claim; reconciliation is required rather than claiming exactly-once delivery.

**How to apply:** Fail closed when a claim cannot be established, retain unknown/claimed outcomes, and require provider reconciliation before a manual retry.

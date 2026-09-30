---
name: DUPR refresh policy
description: Why incremental DUPR refreshes need distinct freshness and progress tracking.
---

Use a distinct last-checked time for DUPR requests, including players without a numeric rating. Keep the rating-source update time intact for confidence scoring. Save successful checks in small batches, and maintain job heartbeats through long imports.

**Why:** The old serial pass queried every player on each refresh, even those without ratings, and buffered results until the end. A long healthy pass was incorrectly reclaimed as crashed after five minutes without a heartbeat, allowing a potentially overlapping run. Source timestamps cannot represent a negative result or a recent check of an unchanged rating.

**How to apply:** Any changes to player imports or DUPR synchronization should preserve negative-result freshness, explicit migration failure, bounded request rate/backoff, batch persistence, and heartbeats for both the import and its parent chain. A catch-up requested without sends must not generate milestone or recap outbound messages.
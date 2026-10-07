---
name: Production sync schedule
description: User-selected time for the automatic production nightly sync.
---

The production nightly sync should run at 3:00 a.m. Eastern, using `America/New_York`.

**Why:** The user chose 3:00 a.m. Eastern.

**How to apply:** Preserve this schedule and timezone when changing deployment or sync configuration. Do not replace it with a UTC hour or the container's local timezone.

---
name: Background worker lease choice
description: Why Supabase REST workers use owner-bound renewable leases and fail-stop on renewal loss.
---

Use owner-bound renewable database leases for long asynchronous jobs invoked through Supabase REST; do not substitute a session-scoped PostgreSQL advisory lock across independent REST calls.

**Why:** REST calls do not retain a dedicated PostgreSQL session throughout a multi-hour job. A session advisory lock would not reliably cover the work. Expiry alone is insufficient: an old process must stop when renewal fails, or it can continue alongside a replacement.

**How to apply:** Acquire atomically, renew before expiry with a bounded request timeout, release only as the owner, and fail closed if the lock schema is unavailable. On lease loss, terminate the worker rather than continuing provider submissions or data mutations.

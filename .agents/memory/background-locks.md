---
name: Background worker lease choice
description: Why Supabase REST workers use owner-bound renewable leases and fail-stop on renewal loss.
---

Use owner-bound renewable database leases for long asynchronous jobs invoked through Supabase REST; do not substitute a session-scoped PostgreSQL advisory lock across independent REST calls.

**Why:** REST calls do not retain a dedicated PostgreSQL session throughout a multi-hour job. A session advisory lock would not reliably cover the work. Expiry alone is insufficient: an old process must stop when renewal fails, or it can continue alongside a replacement.

**How to apply:** Acquire atomically, renew before expiry with a bounded request timeout, release only as the owner, and fail closed if the lock schema is unavailable. On lease loss, terminate the worker rather than continuing provider submissions or data mutations.

Lifecycle verification must exercise production policy in isolated child processes, with external clients replaced and an allowlisted environment.

**Why:** Test-mode shortcuts can bypass leadership gating and process termination, so an in-process test can pass without proving crash safety. Running the production policy is safe only when the fixture cannot inherit shared database credentials or live delivery transports.

**How to apply:** Use a disposable socket-only PostgreSQL cluster and fake delivery records. Accelerate waits, not ownership rules. When simulating passage of a dead worker's lease TTL, account for its orphaned per-job leases as well as its global lease; a replacement can be elected yet temporarily unable to acquire a still-live per-job lock.

Do not compress database abort deadlines as aggressively as election polling in real-database lifecycle tests.

**Why:** Local PostgreSQL requests launched through separate client processes can exceed subsecond deadlines under routine concurrent load, producing false worker deaths even when a quiet run passes.

**How to apply:** Keep ordinary database requests enough execution headroom, use deliberately blocked requests to test bounded timeouts, and preserve the underlying database error in fixture diagnostics.

Startup-failure verification must include the application's own rejection handler, not just a fixture that catches worker failures and exits.

**Why:** Worker election can reject after a scheduler has already created a timer. A fixture-specific exit would hide a missing application fail-stop and falsely prove that partial startup cannot leave work running.

**How to apply:** Keep the real entrypoint and worker/lock policy in the isolated bundle, replace unrelated services, and prove the application fatal path and OS exit before launching replacements. Use a timer that exists before the injected exception.

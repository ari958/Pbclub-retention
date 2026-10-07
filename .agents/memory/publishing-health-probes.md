---
name: Publishing health probes
description: Keep startup checks separate from protected operator pages.
---

Keep operator pages authenticated. Publishing startup checks must use the public, read-only health endpoint, including checks for the dashboard gateway.

**Why:** The gateway can be running correctly while an anonymous request to the dashboard returns 401. Using that protected page as a readiness probe can block publishing even when the API health endpoint returns 200.

**How to apply:** Point startup probes at `/api/healthz`; verify through the gateway that health returns 200 while anonymous dashboard access remains denied. Diagnose startup in an isolated process with background workers and SMS disabled rather than starting production workers for a test.

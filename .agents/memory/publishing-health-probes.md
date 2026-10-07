---
name: Publishing health probes
description: Keep startup checks separate from protected operator pages.
---

Keep operator pages authenticated. Publishing startup checks must use the public, read-only health endpoint, including checks for the dashboard gateway.

**Why:** The gateway can be running correctly while an anonymous request to the dashboard returns 401. Using that protected page as a readiness probe can block publishing even when the API health endpoint returns 200.

**How to apply:** Point startup probes at `/api/healthz`; verify through the gateway that health returns 200 while anonymous dashboard access remains denied. Diagnose startup in an isolated process with background workers and SMS disabled rather than starting production workers for a test.

Keep publishing configuration checks distinct from offline fixture tests and database validation.

**Why:** Offline login fixtures inject synthetic credentials, so their success does not establish that production settings are valid. Checking environment-variable formats also does not establish Supabase connectivity or schema readiness.

**How to apply:** Validate the environment supplied to the actual publishing build process, without substituting development credentials. Describe configuration-only checks as such and explicitly state when database connectivity and schema were not checked.

Evaluate conditional publishing requirements against the production target, not the build shell's runtime mode.

**Why:** A publishing build may run in a development shell but launches a production service; using the shell's mode would omit production-only requirements.

**How to apply:** Reuse side-effect-free runtime policy with an explicit production-mode environment when evaluating the publishing gate. Keep test-only worker overrides out of publishing decisions.

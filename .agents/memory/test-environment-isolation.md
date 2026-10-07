---
name: Test environment isolation
description: Prevent inherited SMS configuration from changing backend test fixture modes.
---

Backend test fixtures must explicitly select normal-recipient or redirected-test mode rather than inheriting the workspace's SMS test override.

**Why:** An inherited `SMS_TEST_OVERRIDE_TO` makes normal-mode LTP fixtures read test controls they do not mock. This can produce failures unrelated to the code being verified.

**How to apply:** For a clean full-suite run, clear `SMS_TEST_OVERRIDE_TO` only in the child test process (for example, `env -u SMS_TEST_OVERRIDE_TO NODE_ENV=test ...`). Tests exercising redirected mode should set their own synthetic override. Never change the app's actual settings to repair test isolation.

---
name: CLI runtime parity
description: Module-resolution and JSX differences between one-off CLI runners and the working application.
---

Keep component tests aligned with the application's JSX runtime. A direct CLI component test can require a React binding even though the same component works correctly under Vite's automatic JSX runtime.

**Why:** A server-rendered component test failed with `React is not defined` while the running application rendered correctly. The failure was in the test runner's JSX transformation, not the component's production behavior.

**How to apply:** Configure automatic JSX for the test runner, or supply the React binding in an isolated test harness. Do not change working production imports solely to accommodate a CLI runtime mismatch.

One-off backend data operations also need production-compatible module resolution.

**Why:** The API's mixed JavaScript/TypeScript imports worked through its production bundler but failed under a default direct CLI runner. This was an execution-harness mismatch, not a broken application import.

**How to apply:** Run operational scripts through a production-compatible build or loader. Do not rewrite working application imports just to make an ad hoc runner resolve them.
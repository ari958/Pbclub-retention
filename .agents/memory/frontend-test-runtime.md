---
name: Frontend test runtime
description: JSX runtime differences between direct CLI component tests and the Vite application.
---

Keep component tests aligned with the application's JSX runtime. A direct CLI component test can require a React binding even though the same component works correctly under Vite's automatic JSX runtime.

**Why:** A server-rendered component test failed with `React is not defined` while the running application rendered correctly. The failure was in the test runner's JSX transformation, not the component's production behavior.

**How to apply:** Configure automatic JSX for the test runner, or supply the React binding in an isolated test harness. Do not change working production imports solely to accommodate a CLI runtime mismatch.
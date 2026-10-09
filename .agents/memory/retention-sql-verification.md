---
name: Retention SQL verification
description: Why source-contract tests alone are insufficient for transactional retention migrations.
---

Signed webhook tests should execute native receipt, opt-out, transition, and alert SQL in a disposable database with fake transports. Give the test process a local worker lease rather than bypassing alert-election guards.

**Why:** Mocked RPC success conceals missing transition prerequisites and alert ownership failures. Scraping another test's SQL template also mixes schema and interpolated seed data.

**How to apply:** Own a dedicated fixture schema matched to production metadata; do not invent a column merely because a function references it. Verify event/alert replay counts and cleanup. Never use shared databases or real SMS transports.

Compile and exercise transactional retention migrations in an isolated PostgreSQL fixture before handing them to the operator. Source-contract checks and TypeScript checks do not prove PL/pgSQL compilation or safe backfill ordering.

**Why:** A migration passed its source-contract tests while still containing a SQL syntax error. Executing it against fake historical rows caught the error and made it possible to verify preservation of approval evidence, capacity replacement, and delivery classification before application.

**How to apply:** When changing retention RPCs or triggers, use a temporary database with fake existing rows and roles. Exercise stale writes, incomplete approval evidence, whole-cohort capacity rollback, real versus test delivery, and irreversible exits. Also exercise subsequent lifecycle transitions: a source replacement intended for candidate updates can accidentally alter unrelated capacity deletions. Source-pattern tests remain useful but are not sufficient evidence by themselves.

Do not use a zero-row HEAD response alone to establish that an external Supabase table exists.

**Why:** In production diagnosis, HEAD with limit zero returned 204 for uninstalled tables, while a zero-row GET correctly reported that those tables were absent from the schema cache.

**How to apply:** Require advertised schema metadata or a zero-row GET for existence/column checks. Keep probes read-only; no mutation or RPC execution is needed to establish schema presence.

Create the isolated database explicitly with UTF-8 encoding.

**Why:** PostgreSQL initialized with `--no-locale` can default to SQL_ASCII, causing valid Unicode punctuation checks such as `chr(8212)` to fail in fixtures even though the application's UTF-8 database supports them.

**How to apply:** Use `initdb -E UTF8` or `createdb -T template0 -E UTF8`; confirm the fixture encoding before interpreting Unicode-related failures as application defects.

Explicitly select the fixture owner when both initializing and querying isolated PostgreSQL.

**Why:** Inherited PostgreSQL environment settings can make the client request a different role from the one created by the fixture initializer.

**How to apply:** Pass a fixed local fixture role to `initdb -U` and `psql -U`, alongside explicit socket, port, and database arguments; never let application connection settings select the fixture target.

Include legacy column defaults in retention fixtures, especially creation-time defaults on pending-message timestamps.

**Why:** A null-default fixture proved draft guards correct but missed the live database populating `sent_at` on unsent pending drafts. A timestamp alone is not delivery evidence.

**How to apply:** Test pending drafts with both null and creation-time defaults. Normalize only newly created, verified test drafts with no approval, schedule, dispatch, or delivery evidence; never reinterpret or rewrite actual sent messages.

Exercise reset followed by fresh regeneration through the application entry point, not just the atomic reset primitive.

**Why:** A guarded reset passed SQL assertions but left a needs-context state that ordinary regeneration rejected. The context-retry path also had narrower accepted reasons and needed the retained pending message's body for its compare-and-swap checks.

**How to apply:** Verify the complete recovery transition, including reason compatibility, existing-message snapshots, approval blocking while facts are rebuilt, and the final unapproved draft. A passing SQL reset test does not establish that the application can finish recovery.

Match affected fixture relations to the actual production columns, types, nullability and defaults before trusting native SQL success.

**Why:** Receipt tests passed because several isolated conversation fixtures supplied a timestamp column absent from production. Executing real SQL against that invented schema missed a live inbound outage.

**How to apply:** Compare read-only production schema metadata, share the verified relation definition across fixtures, and first reproduce the unmodified failing function against it. REST metadata does not expose stored function bodies or all constraints/triggers; report those limits rather than claiming live-definition or full-schema equivalence.
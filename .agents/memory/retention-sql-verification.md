---
name: Retention SQL verification
description: Why source-contract tests alone are insufficient for transactional retention migrations.
---

Compile and exercise transactional retention migrations in an isolated PostgreSQL fixture before handing them to the operator. Source-contract checks and TypeScript checks do not prove PL/pgSQL compilation or safe backfill ordering.

**Why:** A migration passed its source-contract tests while still containing a SQL syntax error. Executing it against fake historical rows caught the error and made it possible to verify preservation of approval evidence, capacity replacement, and delivery classification before application.

**How to apply:** When changing retention RPCs or triggers, use a temporary database with fake existing rows and roles. Exercise stale writes, incomplete approval evidence, whole-cohort capacity rollback, real versus test delivery, and irreversible exits. Source-pattern tests remain useful but are not sufficient evidence by themselves.

Create the isolated database explicitly with UTF-8 encoding.

**Why:** PostgreSQL initialized with `--no-locale` can default to SQL_ASCII, causing valid Unicode punctuation checks such as `chr(8212)` to fail in fixtures even though the application's UTF-8 database supports them.

**How to apply:** Use `initdb -E UTF8` or `createdb -T template0 -E UTF8`; confirm the fixture encoding before interpreting Unicode-related failures as application defects.

Include legacy column defaults in retention fixtures, especially creation-time defaults on pending-message timestamps.

**Why:** A null-default fixture proved draft guards correct but missed the live database populating `sent_at` on unsent pending drafts. A timestamp alone is not delivery evidence.

**How to apply:** Test pending drafts with both null and creation-time defaults. Normalize only newly created, verified test drafts with no approval, schedule, dispatch, or delivery evidence; never reinterpret or rewrite actual sent messages.

Exercise reset followed by fresh regeneration through the application entry point, not just the atomic reset primitive.

**Why:** A guarded reset passed SQL assertions but left a needs-context state that ordinary regeneration rejected. The context-retry path also had narrower accepted reasons and needed the retained pending message's body for its compare-and-swap checks.

**How to apply:** Verify the complete recovery transition, including reason compatibility, existing-message snapshots, approval blocking while facts are rebuilt, and the final unapproved draft. A passing SQL reset test does not establish that the application can finish recovery.
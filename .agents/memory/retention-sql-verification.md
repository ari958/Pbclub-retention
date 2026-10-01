---
name: Retention SQL verification
description: Why source-contract tests alone are insufficient for transactional retention migrations.
---

Compile and exercise transactional retention migrations in an isolated PostgreSQL fixture before handing them to the operator. Source-contract checks and TypeScript checks do not prove PL/pgSQL compilation or safe backfill ordering.

**Why:** A migration passed its source-contract tests while still containing a SQL syntax error. Executing it against fake historical rows caught the error and made it possible to verify preservation of approval evidence, capacity replacement, and delivery classification before application.

**How to apply:** When changing retention RPCs or triggers, use a temporary database with fake existing rows and roles. Exercise stale writes, incomplete approval evidence, whole-cohort capacity rollback, real versus test delivery, and irreversible exits. Source-pattern tests remain useful but are not sufficient evidence by themselves.
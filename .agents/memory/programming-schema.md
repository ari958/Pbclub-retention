---
name: Programming Agent schema
description: Tables created for Phase 2 shadow evaluator (programming_rules, programming_decisions, programming_notifications)
---

## Rule
Migration SQL lives at `artifacts/api-server/migrations/004_programming_tables.sql`. This file must be run in the Supabase SQL editor (service_role required). It cannot be applied programmatically — the project has no DDL execution path via the JS client.

**Why:** Supabase's PostgREST REST API does not support DDL. No `exec_sql` function exists in this project. No database password or management token is available as a secret. Tables are created manually via the Supabase dashboard SQL editor, per the comment in `supabaseClient.ts`.

**How to apply:** Navigate to Supabase Dashboard → SQL Editor → paste the contents of `004_programming_tables.sql` and run.

## Table overview
- `programming_rules` — rule definitions with JSONB `match_rules` and `checkpoints` array
- `programming_decisions` — append-only evaluation log; UNIQUE(event_id, checkpoint_index)
- `programming_notifications` — unused Phase 2; reserved for Phase 3 SMS/notify

## Checkpoint format
```json
[{ "index": 0, "offset_hours": 72, "min_signups": 4, "action": "ALERT" },
 { "index": 1, "offset_hours": 24, "min_signups": 4, "action": "CANCEL" }]
```

## match_rules format
```json
{ "archetype_ids": ["uuid..."], "keywords": ["Open Play"], "podplay_types": [] }
```

## After migration
- Run `POST /api/programming/backfill-fill` with `dryRun: true` to verify the active-count numerator fix
- Create at least one `programming_rules` row with `enabled: true` before testing the evaluator

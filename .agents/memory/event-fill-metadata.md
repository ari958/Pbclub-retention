---
name: Event fill metadata migration
description: Migration 005 adds event_name and podplay_type to event_fill for backtest keyword/type filtering
---

## Rule
Migration 005 SQL is at `artifacts/api-server/migrations/005_event_fill_columns.sql`. Like all DDL in this project, it must be run manually in the Supabase SQL editor. After running, execute `src/scripts/backfillEventFillMetadata.ts` to populate existing rows.

**Why:** The backtest match_rules support three filter types (archetype_ids, keywords, podplay_types). Keywords and podplay_types require event_name and podplay_type respectively, which were not stored in event_fill before this migration.

**How to apply:**
1. Run `migrations/005_event_fill_columns.sql` in Supabase SQL editor
2. Run `npx tsx src/scripts/backfillEventFillMetadata.ts` to populate existing rows
3. New rows are populated automatically by `eventFillSync.ts` going forward

## Pre-migration fallback
The backtest route detects missing columns (catches "does not exist" error on SELECT) and retries without them. When columns are unavailable, `migration_required_note` is added to the response and keyword/podplay_type filters are skipped. archetype_ids filtering still applies.

## Backfill script
`src/scripts/backfillEventFillMetadata.ts` fetches `name` and `customType` from PodPlay API for each row where `event_name IS NULL`. Resumable, ~100ms sleep between calls. Hardcoded to club `c8976e15-e002-4619-bb4b-b1a70f5cd7ab`.

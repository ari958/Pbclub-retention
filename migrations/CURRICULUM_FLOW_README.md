# Curriculum Flow Foundations (v0)

Built: 2026-06-08

This README covers everything you need to execute, test, and extend the
foundational layer built in the `CURRICULUM_FLOW_001/002` migration pair and
the four TypeScript files added in this sprint.

---

## What was built

| Artifact | Location | Purpose |
|---|---|---|
| SQL migration #1 | `migrations/CURRICULUM_FLOW_001_level_history.sql` | Append-only `level_history` table — the spine of the feature |
| SQL migration #2 | `migrations/CURRICULUM_FLOW_002_backfill_seed.sql` | Seeds one row per player who already has a `coach_assigned_level` |
| Rung resolver | `artifacts/api-server/src/lib/curriculumFlow.ts` | SWAP POINT + `loadTaxonomy`, `resolveAttendanceRung`, `buildPlayerRungTimeline` |
| Detectors | `artifacts/api-server/src/lib/curriculumDetectors.ts` | Pure `detectStall` and `detectRetreat` — no DB, fully testable |
| Unit tests | `artifacts/api-server/src/lib/__tests__/curriculumDetectors.test.ts` | 13 hand-built timeline tests via plain `tsx` assertions |
| Audit script | `artifacts/api-server/src/scripts/auditCurriculumCoverage.ts` | Read-only data coverage report |

---

## ⚠ SWAP POINT location

**`artifacts/api-server/src/lib/curriculumFlow.ts` — the `RUNG_CONFIG` object at the top of the file.**

This is the single place where ALL rung-definition assumptions live. When the
Selkirk unified-curriculum definition is available, update **only** this object:

```typescript
export const RUNG_CONFIG = {
  noRungTags:  new Set([...]),  // tags that carry no skill signal
  keywordMap:  [               // program_name fallback patterns
    { pattern: /.../, level: "..." },
  ],
};
```

No other file (detectors, scheduler, routes) contains rung assumptions.

---

## Two SQL files awaiting manual execution

Run these **in order** in the Supabase SQL Editor for each environment (dev then prod):

1. **`migrations/CURRICULUM_FLOW_001_level_history.sql`**
   Creates the `level_history` table, indexes, RLS policies, and grants.
   Safe to run with `CREATE TABLE IF NOT EXISTS` — idempotent.

2. **`migrations/CURRICULUM_FLOW_002_backfill_seed.sql`**
   Seeds one `level_history` row per player who has a `coach_assigned_level`.
   Idempotent via `WHERE NOT EXISTS` guard.
   **Requires migration #1 to be applied first.**

---

## How to run the audit

```bash
pnpm --filter @workspace/api-server exec tsx src/scripts/auditCurriculumCoverage.ts
```

Read-only. Safe to run any time. Output includes:
- Taxonomy listing with ranks
- Player count / `coach_assigned_level` coverage
- Attendance rung resolution breakdown (tag hit / keyword fallback / unresolved)
- Per-player timeline depth
- Dry-run stall + retreat detector counts

### Key audit findings (2026-06-08)

| Metric | Value |
|---|---|
| Total players | 2,006 |
| Players with `coach_assigned_level` | 7 (0.3%) |
| Total attendance rows | 5,765 |
| Tag hit | 1,047 (18.2%) |
| Keyword fallback | 949 (16.5%) |
| Unresolved | 3,769 (65.4%) |
| Overall rung resolution rate | **34.6%** |
| Players with ≥1 resolved attendance | 540 (26.9%) |
| Players with ≥4 resolved attendances (stall-ready) | 132 (6.6%) |
| Stall flag (dry-run) | 74 of 540 (13.7%) |
| Retreat flag (dry-run) | 11 of 540 (2.0%) |

**Interpretation:** The 65.4% unresolved rate is driven by two factors:
1. Events without skill-level tags (e.g., open play sessions tagged only as "All Levels" or untagged entirely)
2. The provisional keyword map in `RUNG_CONFIG` covers only the 5 canonical PB Club levels — any program name that doesn't contain a recognizable keyword falls through

Resolution rate will improve materially once the Selkirk curriculum definition lands and real event-tag coverage is assessed against it.

**Data infrastructure note:** `attendances.club_id` is `NULL` on all existing rows —
`syncEventAttendance.js` never writes it. The audit script scopes to the correct
club by filtering against known player IDs. `buildPlayerRungTimeline` in
`curriculumFlow.ts` looks up the player's `club_id` from the `players` table.

---

## How to run the unit tests

```bash
pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/curriculumDetectors.test.ts
```

13 cases covering: healthy climber, classic stall, classic retreat,
dabble-up-then-back (should NOT fire), empty timeline, single attendance,
threshold edge cases. Exit 0 = all pass.

---

## Synthetic dev data

> **⚠ WIPE BEFORE ANY PRODUCTION CUTOVER.** Synthetic assignments must be removed before real coaches start using the system. Add the wipe step to your pre-launch checklist alongside the `SMS_LIVE` flip and A2P registration.

### What it is

511 players will receive a deterministically-derived `coach_assigned_level` seeded from their modal booking rank. All synthetic rows are tagged `source='synthetic'` in `level_history` and carry the note `"SYNTHETIC dev seed — derived from modal booking rank, bucket=<aligned|deluded|ready>"`. The 7 real coach assignments are never touched.

### Bucket distribution (dry-run 2026-06-09)

| Bucket | Hash range | Logic | Count |
|---|---|---|---|
| aligned | 0–69 | coach level = modal rank | 373 |
| deluded | 70–84 | coach level = modal rank − 1 | 89 |
| ready | 85–94 | coach level = modal rank + 1 | 49 |
| skip | 95–99 | no assignment | 23 |
| **total eligible** | | | **511** |

### How to seed

Step 1 — Run the SQL migrations in the Supabase SQL Editor (if not already done):
```
1. migrations/CURRICULUM_FLOW_001_level_history.sql
2. migrations/CURRICULUM_FLOW_002_backfill_seed.sql
```

Step 2 — Dry-run (safe, no writes):
```bash
pnpm --filter @workspace/api-server exec tsx src/scripts/seedSyntheticCoachLevels.ts
```

Step 3 — Apply (after confirming dry-run output looks right):
```bash
pnpm --filter @workspace/api-server exec tsx src/scripts/seedSyntheticCoachLevels.ts --apply
```

Idempotent: re-running `--apply` skips players that already have a `source='synthetic'` row.

### How to wipe

```bash
# Dry-run first
pnpm --filter @workspace/api-server exec tsx src/scripts/wipeSyntheticCoachLevels.ts

# Apply
pnpm --filter @workspace/api-server exec tsx src/scripts/wipeSyntheticCoachLevels.ts --apply
```

The wipe guards against real reassignments: if a coach has changed a player's level since seeding, that player's `coach_assigned_level` is left alone (only the `level_history` row is deleted).

---

## NOT built yet — next steps

| Item | Notes |
|---|---|
| **Agent catch integration** | Wire stall/retreat signals into the agent's player-profile context so it can reference them in outreach |
| **Level history write path** | When a coach reassigns a player's level via the dashboard, insert a `source='coach'` row into `level_history` |
| **Coach worklist UI** | Dashboard page surfacing players currently flagged as stalled or retreated |
| **Benchmarking across clubs** | Multi-club taxonomy support in detectors (currently single-club) |
| **`attendances.club_id` backfill** | Optional: populate the null `club_id` column retroactively so future queries can filter without the player-ID join workaround |
| **Selkirk curriculum swap** | Replace `RUNG_CONFIG` with the real definition once available |

---

## Architecture diagram

```
attendances.level (tag)  ──┐
attendances.program_name ──┤── resolveAttendanceRung() ── RUNG_CONFIG (SWAP POINT)
level_taxonomy (DB) ────────┘         │
                                       ▼
                           buildPlayerRungTimeline()
                                       │
                          ┌────────────┴────────────┐
                          ▼                         ▼
                    detectStall()            detectRetreat()
                    (pure, no DB)            (pure, no DB)
                          │                         │
                          └────────────┬────────────┘
                                       ▼
                              level_history (DB)
                         (write path — not built yet)
```

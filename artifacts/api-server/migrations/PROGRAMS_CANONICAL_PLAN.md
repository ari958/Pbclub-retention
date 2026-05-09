# Programs Canonical Taxonomy — Migration Plan

**Status:** PHASE 1 IMPLEMENTED — Phase 2 backfill SQL ready to run  
**Author:** session audit, May 2026  
**Option chosen:** Option 3 — Lightweight normalization at the sync layer

---

## Step A — Survey Results

### A.1 Distinct program_name values in attendances (87 total)

```
3 Hour Social Open Play
Challenge Court Social Open Play              ← trailing whitespace
Thursday Evening Social Open Play
$10 Morning Open Play
1 Hour Social Open Play
20% Off 3 Hour Social Open Play              ← trailing whitespace
3.25+ High Intermediate Open Play
30 & 30 Beginner Drills & Guided Play
4 Hour Half Price Christmas Open Play
60 & 60 - Drill Session + Open Play
Advanced 3 Hour Open Play
Advanced Intermediate 60 & 60 - Drill Session + Open Play
Advanced Intermediate 60&60 Clinic
Advanced Intermediate Coach Led 60 & 60 - Drill Session + Guided Play
Advanced Intermediate Open Play
Advanced Intermediate Open Play (3.5-3.99)   ← DUPR range variant
Advanced Intermediate Open Play (3.50-3.99)  ← DUPR range variant (duplicate of above)
Advanced Intermediate Open Play 3.5+         ← DUPR shorthand variant
Advanced Open Play
Advanced Open Play (4.0-4.49)                ← DUPR range variant
Afternoon 2 Hour Social Open Play
Afternoon 3 Hour Social Open Play
Afternoon 4 Hour Social Open Play
Afternoon Social Open Play
Andrea Aguilar's Party
Another! Thursday Night Social Open Play
Chill Vibes Wednesday Nights
Clinic Series - Path to Intermediate Level 1
Co-Working Space
Coach Led 60 & 60 - Drill Session + Guided Play
Coach Led 60 & 60 - Drill Session + Open Play
DUPR Assessment Workshop
DUPR Tracked 2.75-3.25 Intermediate Open Play
DUPR Tracked 3.25-3.75 Advanced Intermediate Open Play
Dinking Dominance Workshop - Intermediate
Early Open Play
Family Open Play
Friday  Social Open Play                      ← double space
Friday Night Social Open Play
Grand Opening Open Play/Open House
Half Price 3 Hour 3.5+ Early Open Play
Half Price 3.25+ Morning Open Play
Half Price Afternoon 3 Hour Open Play
Half Price Afternoon Open Play
Half Price Afternoon Social Open Play
Half Price All Levels Early Open Play
Half Price Christmas Open Play
Half Price Early Open Play
Half Price Early Social Open Play
Half Price Morning Open Play
High Intermediate 3 Hour Open Play
High Intermediate Open Play
Instructional Beginner+ Open Play
Intermediate 60&60 Clinic
Intermediate Coach Led 60 & 60 - Drill Session + Guided Play
Intermediate Open Play
Intermediate Open Play (3.0-3.49)            ← DUPR range variant
Intermediate Play With the Pro: Rob Gruber
Intermediate Skills and Drills
Intermediate+ 60 & 60 - Drill Session + Open Play
Jeremy Zullow Round Robin
Kids Pickleball Mini Camp: 10-13 years old
Kids Pickleball Mini Camp: 7-10 years old
Kids Pickleball Mini Camp: 7-13 years old
Ladies Open Play
Learn to Play Clinic
Low Intermediate Open Play
Lunch Time Drilling
Lunch Time Open Play
Margaret's Court Contract
Mid Day 3 Hour Social Open Play
Moneyball Tournament
Need a DUPR? Book Here
New Years Eve Party Event
Path to Intermediate
Path to Intermediate Level 1
Pizza and Pickleball Social Open Play
Play With the Pro: Brandon Hunter
Play With the Pro: Joe Zee
Play With the Pro: Rob Gruber
Queen of the Court
San's Private Monday Game
Saturday Night Social Open Play
Skills and Drills
Special Event Night @ PB CLUB
Sunday Night Social Open Play
Thursday Night Social Open Play
```

### A.2 Canonical groupings

~15–18 true canonical program shapes hide behind 87 string variants. Main sources of duplication:

| Variant type | Examples | Affected rows |
|---|---|---|
| Trailing whitespace | `"Challenge Court Social Open Play "` | ~2 |
| Double internal space | `"Friday  Social Open Play"` | ~1 |
| DUPR range formatting | `"(3.5-3.99)"` vs `"(3.50-3.99)"` vs `"3.5+"` | ~3 |
| Pricing prefix | `"Half Price …"`, `"$10 …"`, `"20% Off …"` | ~10 |
| Duration prefix | `"3 Hour …"`, `"4 Hour …"`, `"1 Hour …"` | ~6 |
| Time-of-day prefix | `"Afternoon …"`, `"Morning …"`, `"Evening …"` | ~8 |

The warm score `exact program match` signal (warmScore.ts:162) breaks on the DUPR range variants — those three are the highest-priority fix.

### A.3 Distinct program_type values (6)

```
Clinics
Co-Working
Kids Class
Open Play
Private Event
Tournaments
```

Well-structured. No normalization needed on `program_type`.

### A.4 Programs table schema

Table exists in Supabase, 0 rows. Introspection via PostgREST confirms columns include:
`id`, `name`, `description`, `program_type`, `signup_url`, `starts_at`, `ends_at`,
`capacity`, `spots_remaining`, `is_active` (at minimum). Column `event_type` does NOT exist.  
**No migration has ever populated this table.** The live programs catalog is served
entirely from the PodPlay API via `fetchAvailablePrograms.js` — the DB table was
designed aspirationally and is currently unused.

### A.5 Consumers of program_name

| File | Usage | Risk if name changes |
|---|---|---|
| `lib/warmScore.ts:162` | `a.program_name === programName` — exact string match for warm score +8 | HIGH — false negative if variant |
| `lib/warmScore.ts:170,202` | `a.program_type === programType` — type match for warm score +4 / -2 | LOW — types are clean |
| `routes/agent.ts:185` | `programs_attended` dedup set sent to Claude | LOW — cosmetic |
| `routes/agent.ts:192` | `program_name.trim().toLowerCase()` key for recent-sessions context | LOW — already trims |
| `lib/socialGraph.ts:224` | `program_name: event.name` on write — feeds warm score indirectly | MEDIUM |
| `syncEventAttendance.js:305` | `program_name: event.name` — the write path | ROOT CAUSE |
| `assembleProfile.js:23` | `select("attended_at, program_name")` — read only | LOW |
| `dashboard/PlayerDrawer.tsx:1006` | Display only | NONE |

---

## Step B — Chosen Option and Defense

**Option 3 — Lightweight normalization at the sync layer.**

### Why not Option 1 (ETL + programs FK)?
The `programs` DB table is empty and never wired up. Adding a `program_id FK` on `attendances`
requires: ALTER TABLE (lock), a backfill mapping 87 variant strings to canonical IDs, and
updates to warmScore + agent to read via FK instead of string. Risk surface is large and
the gain (referential integrity) is small relative to Option 3.

### Why not Option 2 (Sync from PodPlay catalog)?
`fetchAvailablePrograms.js` already syncs the live catalog from PodPlay for the agent.
The problem is not the live catalog — it is historical `attendances.program_name` strings
already in the DB. PodPlay does not expose a historical programs API, so Option 2 cannot
backfill old attendances.

### Why Option 3 works?
The root cause is `syncEventAttendance.js:305` writing `event.name` verbatim. Adding one
normalization step there — identical in spirit to the `normalizeName` function already used
for player names — collapses variants at the write path going forward. A one-time backfill
(UPDATE WHERE program_name IN (...)) fixes historical rows. No schema changes required.

---

## Migration Plan

### Phase 1 — Normalize at the write path (no downtime)

**File:** `artifacts/api-server/src/syncEventAttendance.js`

Add a `normalizeProgramName(name)` function (similar to `normalizeName` for players):

```js
function normalizeProgramName(name) {
  if (!name || typeof name !== "string") return name;
  return name
    .trim()                               // strips leading/trailing whitespace
    .replace(/\s{2,}/g, " ")             // collapses internal double-spaces
    .replace(/\(3\.50-3\.99\)/g, "(3.5-3.99)")   // DUPR range dedup
    .replace(/\b3\.5\+\b(?!\s*Open)/g, "(3.5-3.99)");  // shorthand dedup
    // Add entries here as new variants are discovered
}
```

Apply at line 305: `program_name: normalizeProgramName(event.name)`.

All future syncs will write the canonical form. Existing rows are fixed in Phase 2.

### Phase 2 — One-time backfill (run in Supabase SQL Editor)

Estimated rows: ~87 distinct names × N attendance rows. The DUPR variants are the
highest-priority rows; trailing-space variants are cosmetic but should be included.

```sql
-- Priority 1: DUPR range dedup (breaks warm score exact match)
UPDATE attendances
  SET program_name = 'Advanced Intermediate Open Play (3.5-3.99)'
  WHERE program_name IN (
    'Advanced Intermediate Open Play (3.50-3.99)',
    'Advanced Intermediate Open Play 3.5+'
  );

-- Priority 2: Whitespace cleanup
UPDATE attendances
  SET program_name = REGEXP_REPLACE(TRIM(program_name), '\s{2,}', ' ', 'g')
  WHERE program_name ~ '^\s|\s$|\s{2,}';

-- Priority 3 (optional — cosmetic): add more UPDATE blocks as needed
-- e.g. normalizing pricing prefixes, duration prefixes, time-of-day prefixes
-- These do NOT break warm score (program_type match still fires); defer until
-- the club agrees on canonical naming.
```

Run in a transaction with a COUNT(*) check before COMMIT.

### Phase 3 — Populate the programs DB table (optional, future)

Once Phase 1 + 2 are stable, the `programs` table can be populated from the live PodPlay
catalog as a snapshot. This is optional and adds referential integrity without changing
any application logic. Defer unless there is a specific feature requirement (e.g. program
analytics page).

---

## Rollback Strategy

- Phase 1 (sync layer): revert `normalizeProgramName` call in `syncEventAttendance.js`.
  Old `event.name` values start writing again on next sync. No DB change needed.
- Phase 2 (backfill): the UPDATE statements are low-risk (no column drops, no FK adds).
  Rollback = re-run the original values as another UPDATE. Before running, take a snapshot:
  `SELECT program_name, COUNT(*) FROM attendances GROUP BY program_name ORDER BY 1;`
  and save the output.

---

## Estimated Scope

- Rows touched (Phase 2): likely 50–500 rows for DUPR variants; 10–50 for whitespace.
  Total attendances table: unknown, but sync runs incrementally so new rows are small.
- Downtime: zero. No schema changes. No FK constraints. Phase 1 is a deploy-time change.
- Phase 2 can run during off-hours; takes < 1 second on any reasonable table size.

---

## Risk Assessment

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Backfill UPDATE matches wrong rows | Low | Medium | Wrap in transaction; check COUNT before COMMIT |
| normalizeProgramName over-collapses distinct programs | Medium | High | Keep rules minimal; only fix confirmed variants |
| Phase 1 deployed before Phase 2 backfill | Low | Low | Old rows retain old strings; warm score improvement arrives after backfill |
| programs DB table populated prematurely | N/A | Medium | Phase 3 is explicitly deferred |

---

## Open Questions — ANSWERED

1. **How many attendance rows have each variant string?** ✅ ANSWERED (May 2026, live DB query)

   | program_name | rows |
   |---|---|
   | `Advanced Intermediate Open Play (3.5-3.99)` | 64 ← canonical |
   | `Advanced Intermediate Open Play 3.5+` | 40 ← variant → normalised |
   | `Advanced Intermediate Open Play (3.50-3.99)` | 24 ← variant → normalised |
   | `Intermediate Open Play (3.0-3.49)` | 30 ← standalone (not a variant) |
   | `Advanced Open Play (4.0-4.49)` | 27 ← standalone (not a variant) |
   | `20% Off 3 Hour Social Open Play ` (trailing space) | 124 ← whitespace fix |
   | `Friday  Social Open Play` (double space) | 12 ← whitespace fix |
   | `Challenge Court Social Open Play ` (trailing space) | 0 (safe to ignore) |

   Total attendances table: 5,765 rows. Distinct program_name values: 87.

2. **Does the club want pricing/duration variants collapsed?** ✅ ANSWERED

   **Decision: NO.** `"Half Price X"`, `"$10 X"`, `"20% Off X"` etc. are genuinely distinct
   programs (different pricing, potentially different session mix). The warm score `program_type`
   match (+4) still fires for all Open Play variants via `event.customType/type`. Collapsing
   pricing variants would falsely elevate warm scores for players who only attended discounted
   sessions. Defer Phase 3 pricing/duration normalization unless the club explicitly requests it.

3. **Does PodPlay have a stable `programId` or `templateId` per recurring program?** ✅ ANSWERED

   **No.** `syncEventAttendance.js:304` stores `event.id` (a per-occurrence instance ID, not a
   series/template ID). The PodPlay `/apis/v2/events` endpoint does not expose a template or
   series ID in the current integration. Option 2 (sync via FK) is not viable without further
   PodPlay API investigation. Deferred.

4. **Is warm score "exact program match" (+8) behaving as intended?** ✅ ANSWERED — CRITICAL BUG

   **0 of 1,000 scored players have warm_score ≥ 8.** The +8 signal (`warmScore.ts:162`
   exact string match) has never fired. Root cause confirmed: DUPR range variant strings
   (`(3.50-3.99)`, `3.5+`) prevent exact match. Phase 1 normalization (now deployed to
   sync layer) stops the bleed. Phase 2 backfill (below) heals the 64 historical rows.
   After Phase 2, the next churn-score batch will recompute and warm scores will update.

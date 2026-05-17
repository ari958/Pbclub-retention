# Phase 0 — Multi-Tenant Refactor Guide

## Goal

Turn every hardcoded `CLUB_ID` and `pbclub.podplay.app` reference into a
request-scoped value. After Phase 0 PB Club must work end-to-end with **zero
user-facing differences**.

---

## What Changed

### New lib files

| File | Purpose |
|---|---|
| `artifacts/api-server/src/lib/clubResolver.ts` | `requireClub` middleware — resolves `?clubId=<uuid>` or `?slug=<slug>` on every request and attaches `req.clubId` |
| `artifacts/api-server/src/lib/podplayUrls.ts` | `getPodPlayBaseUrl(clubId)` — looks up `platform_subdomain` from Supabase and returns `https://<subdomain>.podplay.app` |
| `artifacts/dashboard/src/lib/ClubContext.tsx` | React context that holds the active `clubId` and `slug` |
| `artifacts/dashboard/src/components/ClubSwitcher.tsx` | Dropdown populated from `GET /api/clubs` — stamps `?slug=<slug>` onto every outgoing fetch |

### New / updated API routes

| Route | Change |
|---|---|
| `GET /api/clubs` | New — list all clubs |
| `GET /api/clubs/by-slug/:slug` | New — resolve slug → club row |
| `PATCH /api/clubs/:id/settings` | Renamed from `/settings` |

### Routes that gained `requireClub` middleware

All routes below now require either `?clubId=<uuid>` or `?slug=<slug>`:

- `GET/PATCH /api/players/*`
- `POST /api/sync/player`, `/sync/all`, `/sync/events`, `/sync/level-confidence`
- `GET /api/programs`
- `GET/POST/PATCH /api/templates`
- `POST /api/feedback/*`
- `POST /api/messages/send`, `/messages/skip`, `/messages/bulk`, `PATCH /messages/:id/draft`
- `POST /api/recap/monthly`, `/recap/monthly/test`, `/recap/milestones`, `/recap/milestones/test`
- `POST /api/import/*`
- `POST /api/onboarding/complete`
- `GET/POST /api/social-graph/*`
- `GET/POST /api/events/*`

**Intentionally NOT gated** (no club context available at call time):
- `POST /api/messages/webhook/status` — Twilio posts without club context
- `POST /api/messages/webhook/inbound` — Twilio posts without club context; player lookup resolves club internally
- `GET /api/onboarding/status` — must be callable before club is known

### JS worker files updated

| File | Change |
|---|---|
| `importAllPlayers.js` | Added `clubId` param; fetches `platform_subdomain` from Supabase |
| `syncEventAttendance.js` | Added `clubId` param; fetches `platform_subdomain` from Supabase |
| `fetchAvailablePrograms.js` | Added optional `clubId` param; backward-compat fallback queries first club |
| `importPhoneNumbers.js` | Added `clubId` param; fetches `platform_subdomain` from Supabase |

### `interpolate()` fix in messages.ts

The `{{club_name}}` replacement previously hardcoded `"PB Club"`. It now
accepts a `clubName` argument fetched from `clubs.name` at send time.

---

## Backward Compatibility

Two transitional fallbacks are still in place for code **not yet updated** in
this phase (scheduler + agent — handled in Steps 7 and 8):

1. `fetchAvailablePrograms.js` — if called without `clubId`, queries
   `SELECT platform_subdomain FROM clubs LIMIT 1`.
2. `postSessionFeedback.ts` — `resolvePodPlayBase(clubId?)` falls back to
   the same first-club query if `clubId` is undefined.

These fallbacks will be removed once Steps 7 and 8 are complete.

---

## Remaining Hardcodes (deferred)

| Location | What | Deferred to |
|---|---|---|
| `lib/scheduler.ts` | `CLUB_ID` constant, used by nightly chain | Step 7 |
| `routes/agent.ts` | `CLUB_ID` constant, used by AI agent | Step 8 |

---

## Verification Checklist

After applying this phase, run:

```bash
# Must show ONLY scheduler.ts and agent.ts
grep -rn "CLUB_ID\b" artifacts/api-server/src/

# Must show ONLY comment lines in podplayUrls.ts
grep -rn "pbclub\.podplay\.app" artifacts/api-server/src/

# Must show zero results
grep -rn '"PB Club"' artifacts/api-server/src/

# Must pass with zero errors
pnpm run typecheck
```

---

## Database Requirements

All routes read `clubs.platform_subdomain` (added in migration
`20260503_onboarding.sql`). Ensure that column is populated for every club
before routing requests to Phase-0-updated routes.

```sql
-- Check
SELECT id, name, platform_subdomain FROM clubs;

-- Fix if null
UPDATE clubs SET platform_subdomain = 'pbclub' WHERE slug = 'pb-club';
```

---

## Frontend Integration (Phase 1)

The dashboard `ClubSwitcher` component and `ClubContext` are in place but not
yet wired into every `fetch()` call. Phase 1 will:

1. Wrap all API calls with the active `?slug=<slug>` parameter
2. Remove the hardcoded `?slug=pb-club` default from `ClubContext`
3. Gate every dashboard page behind the club context being resolved

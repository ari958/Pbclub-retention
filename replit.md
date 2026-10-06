# Pulse — PB Club Pickleball Retention Dashboard

## Overview

pnpm workspace monorepo. React+Vite+TS dashboard, Express 5 API server, Supabase (Postgres).

## Stack

- **Monorepo**: pnpm workspaces
- **Node.js**: 24 · **TypeScript**: 5.9 · **Package manager**: pnpm
- **API**: Express 5, esbuild bundle
- **DB**: Supabase (Postgres) via `@supabase/supabase-js` service_role key
- **Validation**: Zod
- **AI**: Anthropic SDK (`claude-sonnet-4-5`, `claude-sonnet-4-6`)
- **SMS**: Twilio

## Key Commands

- `pnpm run typecheck` — full typecheck
- `pnpm --filter @workspace/api-server run build` — build API
- `pnpm --filter @workspace/api-server run dev` — run API locally

## Project Constants

- `CLUB_ID`: `c8976e15-e002-4619-bb4b-b1a70f5cd7ab` — never hardcode
- Supabase project ref: `knblhxfwvebxntoshiqm`
- `DATABASE_URL` → Replit local DB (not Supabase). All DDL runs in Supabase SQL Editor.

## Architecture

### Artifacts
| Artifact | Kind | Path |
|---|---|---|
| `artifacts/api-server` | API | `/api` |
| `artifacts/dashboard` | Web (React+Vite) | `/dashboard` |

### API Server — `artifacts/api-server/src/`
- `app.ts` — Express app, mounts all routes under `/api`
- `routes/index.ts` — barrel: agent, sync, players, messages, recap, socialGraph, feedback, templates, events, import, admin, programs, health, onboarding
- `lib/supabaseClient.ts` — singleton Supabase client (service_role)
- `lib/jobStore.ts` — `startJob / finishJob / appendJobLog / getJob / isCancelled`
- `lib/scheduler.ts` — nightly chain (Steps 1–7), feedback poller (30 min)
- `lib/churnScore.ts` — churn scoring engine; thresholds 70+/40–69/0–39
- `lib/monthlyRecap.ts` — monthly recap generation + batch runner
- `lib/milestoneCheck.ts` — milestone detection + batch runner
- `lib/levelConfidence.ts` — session-based level confidence scoring
- `lib/postSessionFeedback.ts` — post-session SMS feedback
- `lib/logger.ts` — pino logger singleton (use `req.log` in routes, `logger` elsewhere)

### Nightly Chain (scheduler.ts)
1. Player import
2. Incremental event sync (14 days)
3. Level confidence recompute
4. Buddy pair graph
5. Churn score recompute
6. **Milestone check** (every night)
7. **Monthly recap batch** (1st of month only — prior month)

### Dashboard — `artifacts/dashboard/src/`
- `pages/Dashboard.tsx` — Recommendation tiles → Stat strip → Bento grid (no AI briefing banner)
- `pages/Players.tsx` — Player list with churn badge + filter chip
- `pages/Settings.tsx` — Club config, sync schedule, Monthly Recap & Milestones panel, Message Templates
- `components/PlayerDrawer.tsx` — Player detail drawer with churn risk section
- `lib/types.ts` — `Player` interface (includes `churn_risk`, `churn_score`)

## Single-club testing and parked onboarding

`DEFAULT_CLUB_SLUG=pb-club` is the default for unscoped API requests and the frontend club lookup. Resolve it by slug, never by the first row: the database contains a separate `test-club` row. Explicit club IDs/slugs remain validated. Startup logs identify the default club, and club-scoped request logs and the `X-Resolved-Club-Id` response header identify the resolved club.

- `/` and `/onboarding` open the default club's dashboard. In the dashboard artifact, its base path is `/dashboard/`, so the final URL is `/dashboard/c/pb-club/dashboard`.
- `OnboardingGuard` and the wizard remain in the source tree but are not mounted. The stored `clubs.onboarded` value must not gate dashboard access or be rewritten to bypass onboarding.
- `/api/onboarding/*` returns 404 while `RETENTION_ONLY_MODE=true`. The existing wizard/API implementation is parked for a later phase.
- Retention navigation includes Dashboard and Approvals; the multi-club switcher is parked. Operator password login gates pages, assets, and APIs; only login/session/logout, signed Twilio callbacks and aggregate health are public.
- Production runs in one Reserved VM. Only production may enable `RUN_BACKGROUND_JOBS=true`; development must remain false to avoid duplicate work against the shared Supabase database. See `PRODUCTION_DEPLOYMENT.md` for manual setup and verification boundaries.
- Dashboard reads are scoped to the active club, including messages with no conversation. This routing policy does not change SMS approval, dispatch, kill-switch, live-mode or operator-override rules.

### Preserved wizard implementation (currently parked)

- **Step 1** — Club basics: name, timezone, nightly sync time.
- **Step 2** — Platform selection (PodPlay or CourtReserve) + API credentials + live validation via `POST /api/onboarding/validate`. For CourtReserve, also selects skill rating category from the fetched category list.
- **Step 3** — Confirms settings, saves via `POST /api/onboarding/complete`, then triggers initial player import and polls progress.
- **Migration pending fallback**: if `onboarded` column is missing (migration not yet applied), the status endpoint returns `onboarded=true` so existing clubs are never disrupted.

### Pending migration
Run `supabase/migrations/20260503_onboarding.sql` in the Supabase SQL editor once per environment:
```sql
ALTER TABLE clubs
  ADD COLUMN IF NOT EXISTS platform              text    NOT NULL DEFAULT 'podplay',
  ADD COLUMN IF NOT EXISTS platform_api_key      text,
  ADD COLUMN IF NOT EXISTS platform_org_id       text,
  ADD COLUMN IF NOT EXISTS cr_rating_category_id text,
  ADD COLUMN IF NOT EXISTS onboarded             boolean NOT NULL DEFAULT false;
UPDATE clubs SET onboarded = true, platform = 'podplay' WHERE onboarded = false;
```

## Supabase Tables (key)

| Table | Purpose |
|---|---|
| `players` | Core player data + `churn_score int`, `churn_risk text` |
| `attendances` | Session attendance records |
| `buddy_pairs` | `player_a`, `player_b`, `shared_sessions` — **no `id` column** |
| `conversations` | Message threads (triggered_by field used for context) |
| `messages` | Outbound/inbound SMS, `status: pending/sent/replied` |
| `jobs` | Job tracking rows (id = job name) |
| `player_milestones` | `UNIQUE(player_id, milestone_type)` — milestone trigger history |
| `monthly_recaps` | `UNIQUE(player_id, recap_month)` — recap dedup (format: "2026-04") |

### `clubs` table columns (after migration)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `name` | text | Club display name |
| `timezone` | text | IANA timezone string |
| `scheduled_sync_time` | text | `"HH:MM"` — nightly sync trigger |
| `agent_config` | jsonb | Agent settings (tone, limits, etc.) |
| `platform` | text | `'podplay'` or `'courtreserve'` |
| `platform_api_key` | text | API key for the platform |
| `platform_org_id` | text | CourtReserve org integer ID (stored as text) |
| `cr_rating_category_id` | text | CourtReserve custom rating category ID |
| `onboarded` | boolean | `false` → show onboarding wizard |

## Recap & Milestone System

### Monthly Recap (`/api/recap/monthly`)
- `POST /api/recap/monthly` — start batch (fire-and-forget)
- `GET /api/recap/monthly/status` — job status
- `POST /api/recap/monthly/test` — dry_run single player (returns generated message, no DB writes)
- Skips players with < 2 sessions in the month, sms_opt_in false, or no phone
- Stats: sessions this month, total sessions ever, unique court partners, top 3 partners by name

### Milestone Messages (`/api/recap/milestones`)
- `POST /api/recap/milestones` — start batch
- `GET /api/recap/milestones/status` — job status
- `POST /api/recap/milestones/test` — dry_run single player (returns all_previews array)
- Types: `session_10`, `session_25`, `session_50`, `best_month` (monthly repeat), `streak_3w` (21-day cooldown)

## Churn Score Model
- S1: Days since last visit (0–40 pts)
- S2: Visit frequency trend (0–20 pts)
- S3: Membership status (0–15 pts)
- S4: Message non-response — requires ≥3 outbound first (0–15 pts)
- S5: Social isolation via buddy_pairs (0–10 pts)
- Thresholds: HIGH ≥70 / MEDIUM 40–69 / LOW 0–39

## Developer Documentation

### Approved retention mode

- Preserve legacy feature code; disable/park it rather than deleting it.
- `RETENTION_ONLY_MODE` defaults true, `REQUIRE_MARKETING_CONSENT` defaults false, and `VITE_NAV_MODE=retention` selects the approvals-focused navigation.
- Explicit per-message approval is a global dispatch requirement, not a flag that retention mode may bypass. Edits invalidate approvals; approvals must bind the operator's exact reviewed text.
- The typed `approved_by` label is not authenticated identity. Do not describe it as staff sign-in.
- The application database is the existing external Supabase project. Apply migration `010_retention_approvals.sql` manually there; never substitute the local Replit `DATABASE_URL`.
- New retention tables/RPCs are service-role-only, with no anonymous/authenticated table grants. This is an exception to the older general grant note below.
- Follow `RETENTION_ROLLOUT.md` for controlled operator-only acceptance, test-ledger semantics and ambiguous-send reconciliation. Do not declare live acceptance complete from mock tests or a screenshot.

Full technical reference is maintained at `pulse-technical-docs.md` in the project root.
Update it whenever you make significant changes: new tables, new API routes, new engines, schema changes, or ops procedure changes.

## Notes
- Never use `console.log` in server code — use `req.log` (routes) or `logger` (lib)
- All player queries on buddy_pairs must select `player_a` (no `id` column)
- Supabase permission pattern: after any new table, run `GRANT SELECT, INSERT, UPDATE ON <table> TO service_role; GRANT SELECT ON <table> TO anon;`
- model string for Anthropic: `claude-sonnet-4-5` (recap/milestones), `claude-sonnet-4-6` (agent)

# CLAUDE.md — PB Club Retention Agent (Pulse)

Read this first in every session. Deeper detail lives in:
- `RUNBOOK.md` — audit changelog, open items, debugging scenarios
- `SUPABASE_SCHEMA_EXPORT.md` — tables, FKs, RLS, indexes
- `PODPLAY_API_REFERENCE.md` — PodPlay API v2 offline reference
- Level-confidence skill (`pb-club-level-confidence/SKILL.md`) — read before touching `level_confidence`, `session_feedback`, `level_taxonomy`, `level_history`, `coach_assigned_level`, or `dupr_rating`

If anything in this file disagrees with the code, the code wins. Say so and propose a fix to this file.

---

## ⚠️ Production is live. Read this before running anything.

Real SMS goes to real PB Club players. Production runs on a Replit Reserved VM (`retention-agent-ari205.replit.app`). The Learn to Play follow-up flow went live 2026-10-08.

**Hard rules for any non-production environment:**
- `SMS_LIVE=false`. Never set it to true outside production.
- The scheduler must be OFF. The per-day idempotency guard does **not** protect against two instances running at once. A second scheduler means players get double-texted.
- Never run batch jobs (`nightly_sync`, churn, milestones, recaps, post-session feedback) against the production Supabase project from dev unless explicitly told to.
- Never send to a real player number from dev. Ari's own number is a registered player record and is the only acceptable test recipient.
- Anything that mutates live data, schedules sends, or touches PodPlay write endpoints: **dry-run first, show the result, wait for confirmation.**

---

## Stack

- `artifacts/api-server` — Express + TypeScript API server (some legacy `.js` files)
- `artifacts/dashboard` — React + Vite operator dashboard (operator-password login)
- Supabase (Postgres), project `knblhxfwvebxntoshiqm`
- PodPlay API v2 — `https://pbclub.podplay.app/apis/v2`, auth via `x-api-key` header (not bearer, despite the spec)
- Twilio SMS — sending number `+12015281834`
- Anthropic — Sonnet for message generation (Opus hallucinated player context in an A/B eval; stay on Sonnet)

Architecture is multi-tenant (`clubs.slug`, `ClubContext`, `/c/:slug/*` routes), but the product runs single-club (PB Club, slug `pb-club`, id `c8976e15-e002-4619-bb4b-b1a70f5cd7ab`).

## Commands

Run from the repo root. pnpm only (`preinstall` rejects npm/yarn). Verified 2026-10-09.

- Install: `pnpm install`
- Dev server (API): `pnpm --filter @workspace/api-server run dev`. Bundles with esbuild, then runs `dist/index.mjs` with `NODE_ENV=development`, so background jobs can't start. Needs `PORT`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Exits on boot if the default club can't be resolved.
- Dev server (dashboard): `pnpm --filter @workspace/dashboard run dev`. Needs `PORT`, `BASE_PATH` (`/dashboard/`) and `DEFAULT_CLUB_SLUG`. Proxies `/api` to `localhost:${API_PORT:-8080}`.
- Typecheck: `pnpm run typecheck`. Runs `tsc --build` on `lib/*`, then `tsc -p tsconfig.json --noEmit` in each artifact and in `scripts`. Run it before declaring any change done.
- Build: `pnpm run build`. Typechecks, then builds every package. Needs `PORT`, `BASE_PATH` and `DEFAULT_CLUB_SLUG` set (the mockup-sandbox and dashboard vite configs throw without them).
- Tests (api-server, `node:test` via tsx). Always run them with `SMS_LIVE=false RUN_BACKGROUND_JOBS=false NODE_ENV=test` and `SMS_TEST_OVERRIDE_TO` unset.
  - `pnpm --filter @workspace/api-server run test:publishing-health`: offline, but `SUPABASE_URL` must be set to something (a dummy works) or the client constructor throws.
  - `pnpm --filter @workspace/api-server run test:production-preflight`: offline.
  - `pnpm --filter @workspace/api-server run test:worker-lifecycle`: starts a throwaway local Postgres. Needs `initdb`, `pg_ctl` and `psql` on `PATH`, a non-root user, and a short `TMPDIR` (the Unix socket path limit is about 107 characters).
- Not run, and don't run casually: `lib/db` `push` / `push-force` (drizzle schema push to the live DB), `api-server` `eval` (paid Anthropic calls), `api-spec` `codegen`.

---

## Architectural rules (each one caused a real bug)

**Supabase clients**
- Dashboard uses the anon key and is **SELECT-only**. All dashboard writes go through `/api/*` endpoints. Anon writes return HTTP 200 with empty arrays and persist nothing.
- API server `.ts` files import the shared singleton from `lib/supabaseClient.ts`. No inline `createClient` in `.ts` files.
- Legacy `.js` files (`syncEventAttendance.js`, `importAllPlayers.js`, `assembleProfile.js`) create their own client with `SUPABASE_SERVICE_ROLE_KEY`.
- Never fall back to the anon key on the server (`?? process.env.SUPABASE_ANON_KEY` is banned).

**supabase-js behavior**
- Errors come back in the result; they are not thrown. Always destructure and check `{ data, error }`. A `try/catch` alone is dead code.
- Default 1,000-row limit. Any query over players or attendances must paginate.

**RLS**
- Every table: `service_role_all_<table>` + `anon_read_<table>`. Only `session_feedback` allows anon INSERT (Twilio webhook).
- After any migration: `GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`

**messages table**
- Every insert must set `player_id` (NOT NULL).
- Queued (unsent) messages must explicitly set `sent_at: null`. The default is `now()`.

**Single source of truth**
- If something can be computed deterministically, compute it in code and pass it into the prompt. Don't ask Claude to compute it. (Example: `engagement_state` is server-computed and overrides model output.)

**Migrations and triggers**
- New mutable tables get the `set_updated_at()` BEFORE UPDATE trigger.
- All timestamps are `timestamptz`, except `players.last_visit_date` (club-local `date`) and `buddy_pairs.last_shared_at`.

---

## Domain rules

- **Enrollment ≠ readiness.** Only a coach assessment sets `progression_status` or promotes a level. The system never promotes anyone; it proposes and the coach decides.
- Level-gated events are excluded from automated outreach.
- Signup `status = INVALID` marks completed series-pass clinic enrollments. **Do not exclude it.** Excluding it once zeroed out whole program archetypes.
- Enrollment counts: never use `_total` or `items.length` blindly. Filter on signup status, and decide explicitly whether `guests` count as bodies.
- PodPlay: signups = registered, attendees = historical. The `/events` `userId` filter is a no-op. There's no create-from-scratch event endpoint (use `POST /events/clones`, then `PATCH`). Price is `admissionRate.regular` / `.member`.
- Engagement states: active ≤14d, lapsing 15–30d, dormant 31d+. Outreach targets lapsing and recent dormant (31–90d). Long dormant (91d+) is excluded from clinic-fill outreach.

## Locked decisions. Don't re-raise these.

- Consent is implicit for retention texts. Any player with a phone number is eligible, and Twilio handles opt-outs.
- Every outbound text is operator-approved before it sends.
- Learn to Play follow-up: max 2 texts. Text 1 is a thank-you plus promo code `LTPNEXT25`, plus a next beginner program if one exists (skip the suggestion if none). Text 2 goes 7 days later if they haven't booked, with no promo code. Booking moves the player to the next flow.
- Experiments: 70/30 treatment/control, 30-day holdout, max 2 promotional SMS per player per 30 days, 7-day cooldown, and manual approval before dispatch.
- Cancellation thresholds: N=4 / T-2h for open play, N=2 / T-2h for clinics.

## Message voice (enforced in the system prompt; keep it enforced)

- Sound like a friendly human at the club, not a template.
- 1–3 sentences, one ask only, always use contractions.
- No em-dashes, no exclamation points, no banned AI words.
- Truthfulness: no inferred motivations, no history the data doesn't show, no unsupported adjectives, no time references that can't be derived from data.
- Send only inside the TCPA window (8am–7:30pm weekdays, 8:30am–7:30pm weekends), enforced by `sanitizeScheduledSendAt`.

---

## How to work in this repo

- **Audit before fixing.** Read the relevant code and report what's actually there before changing anything. Runbook items have gone stale before (4 of 5 in the June sweep were already fixed).
- For multi-item tasks, keep items independent and report a per-item status: `CLOSED` / `PARTIAL` / `DEFERRED` / `REVERTED`, with one line of evidence (file:line, query result).
- Stop and ask on anything ambiguous, anything irreversible, and anything touching live sends or production data.
- `tsc --noEmit` must pass before calling a change done.
- Explain findings in plain English from a club owner's point of view, not just engineering terms.
- After significant work, update `RUNBOOK.md` (changelog plus open items) and `SUPABASE_SCHEMA_EXPORT.md` if the schema changed.

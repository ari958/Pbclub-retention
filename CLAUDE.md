# CLAUDE.md — PB Club Retention Agent (Pulse)

Read this first in every session. Deeper detail lives in:
- `RUNBOOK.md` — audit changelog, open items, debugging scenarios, kill switch
- Migrations are the schema source of truth: `artifacts/api-server/migrations/` (numbered, current), plus older files in `migrations/` and `supabase/migrations/`. There is no schema export.
- `PODPLAY_API_REFERENCE.md` — PodPlay API v2 offline reference
- Level-confidence skill (installed skill `anthropic-skills:pb-club-level-confidence`, not a repo file) — load before touching `level_confidence`, `session_feedback`, `level_taxonomy`, `level_history`, `coach_assigned_level`, or `dupr_rating`

If anything in this file disagrees with the code, the code wins. Say so and propose a fix to this file.

---

## ⚠️ Production is live. Read this before running anything.

Real SMS goes to real PB Club players. Production is one Railway service, `pbclub-retention-production.up.railway.app`, deployed from `main` on every merge (`railway.json`; see `RUNBOOK.md` "Hosting"). Replit is gone. The Learn to Play follow-up flow went live 2026-10-08.

**Hard rules for any non-production environment:**
- `SMS_LIVE=false`. Never set it to true outside production. A server with `SMS_LIVE=true` and `NODE_ENV` other than `production` refuses to start (`backgroundEnvironment.mjs`, `nonProductionLiveSmsError`).
- The scheduler must be OFF. It runs only when `NODE_ENV=production`, `RUN_BACKGROUND_JOBS=true` **and** `SCHEDULER_ENABLED=true` (`backgroundEnvironment.mjs`). Live texts also need `SCHEDULER_ENABLED=true`. `SCHEDULER_ENABLED` is a variable on the one live service only. Never commit it or set it anywhere else: it is the only thing keeping a staging copy or second service with copied env vars quiet.
- Two instances on the **same** Supabase project can't both run the scheduler: a database lease elects one leader (`backgroundWorker.ts`, `backgroundLock.ts`). That lease does nothing for an instance pointed at a **different** database (a copy of prod data plus real Twilio credentials would text players). Hence the kill switch.
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
- Anthropic — Sonnet for all message generation via `AGENT_MODEL` in `artifacts/api-server/src/lib/anthropicConfig.ts` (default `claude-sonnet-4-6`, override with `ANTHROPIC_AGENT_MODEL`). Retention text, the agent route, milestones and monthly recaps all use it; don't hard-code model IDs elsewhere. `/agent` also accepts a per-request `_model` override. Opus hallucinated player context in an A/B eval (`src/scripts/compareAgentModels.ts`); stay on Sonnet.

Architecture is multi-tenant (`clubs.slug`, `ClubContext`, `/c/:slug/*` routes), but the product runs single-club (PB Club, slug `pb-club`, id `c8976e15-e002-4619-bb4b-b1a70f5cd7ab`).

## Commands

Run from the repo root. pnpm only (`preinstall` rejects npm/yarn). Verified 2026-10-09.

- Install: `pnpm install`
- Dev server (API): `pnpm --filter @workspace/api-server run dev`. Bundles with esbuild, then runs `dist/index.mjs` with `NODE_ENV=development`, so background jobs can't start. Needs `PORT`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Exits on boot if the default club can't be resolved.
- Dev server (dashboard): `pnpm --filter @workspace/dashboard run dev`. Needs `PORT`, `BASE_PATH` (`/dashboard/`) and `DEFAULT_CLUB_SLUG`. Proxies `/api` to `localhost:${API_PORT:-8080}`.
- Production build (what Railway runs): `node artifacts/api-server/production-build.mjs`. Validates env, runs a read-only Supabase preflight (needs real credentials), then builds dashboard and API. Start: `node --enable-source-maps artifacts/api-server/dist/index.mjs`; the API serves the dashboard at `/dashboard`.
- Typecheck: `pnpm run typecheck`. Runs `tsc --build` on `lib/*`, then `tsc -p tsconfig.json --noEmit` in each artifact and in `scripts`. Run it before declaring any change done.
- Build: `pnpm run build`. Typechecks, then builds every package. Needs `PORT`, `BASE_PATH` and `DEFAULT_CLUB_SLUG` set (the dashboard vite config throws without them).
- Tests (api-server, `node:test` via tsx). Always run them with `SMS_LIVE=false RUN_BACKGROUND_JOBS=false NODE_ENV=test` and `SMS_TEST_OVERRIDE_TO` unset.
  - `pnpm --filter @workspace/api-server run test:publishing-health`: offline, but `SUPABASE_URL` must be set to something (a dummy works) or the client constructor throws.
  - `pnpm --filter @workspace/api-server run test:production-preflight`: offline.
  - `pnpm --filter @workspace/api-server run test:worker-lifecycle`: starts a throwaway local Postgres. Needs `initdb`, `pg_ctl` and `psql` on `PATH`, a non-root user, and a short `TMPDIR` (the Unix socket path limit is about 107 characters).
- Not run, and don't run casually: `lib/db` `push` / `push-force` (drizzle schema push to the live DB), `api-server` `eval` (paid Anthropic calls), `api-spec` `codegen`.

---

## Architectural rules (each one caused a real bug)

**Supabase clients**
- Dashboard uses the anon key (`artifacts/dashboard/src/lib/supabase.ts`) and is **SELECT-only**. All dashboard writes go through `/api/*` endpoints with `fetch(clubApiUrl(slug, "/api/..."))` (e.g. `POST /api/messages/mark-read`, `/api/messages/skip`). Anon writes return HTTP 200 with empty arrays and persist nothing.
- API server `.ts` files import the shared singleton from `artifacts/api-server/src/lib/supabaseClient.ts`. No inline `createClient` in server `.ts` files. Known exceptions, all standalone scripts on the service-role key: `src/scripts/dryRunCatalog.ts`, `patchKeywords.ts`, `compareAgentModels.ts`.
- Legacy `.js` files in `artifacts/api-server/src/` (`syncEventAttendance.js`, `syncPlayerAttendance.js`, `importAllPlayers.js`, `importPhoneNumbers.js`, `assembleProfile.js`, `dedupeAttendances.js`, `fetchAvailablePrograms.js`, `scripts/importSmsConsent.js`) create their own client with `SUPABASE_SERVICE_ROLE_KEY`.
- Never fall back to the anon key on the server (`?? process.env.SUPABASE_ANON_KEY` is banned).

**supabase-js behavior**
- Errors come back in the result; they are not thrown. Always destructure and check `{ data, error }`. A `try/catch` alone is dead code.
- Default 1,000-row limit. Any query over players or attendances must paginate.

**RLS**
- Grant per table, never schema-wide. **Never run `GRANT ... ON ALL TABLES IN SCHEMA public TO anon`**: it undoes the deliberate blocks below.
- Sensitive tables (approvals, operator runtime and alerts, inbound SMS, reports) deliberately block anon: `REVOKE ALL ... FROM anon` with service-role-only access. Copy the pattern in `artifacts/api-server/migrations/010_retention_approvals.sql`, `017_operator_runtime.sql`, `020_operator_alert_incidents.sql` and `021_sms_inbound_receipts.sql`.
- Tables the dashboard reads get an explicit `GRANT SELECT ON TABLE <name> TO anon` plus a read policy. Older tables use `service_role_all_<table>` / `anon_read_<table>` (e.g. `004_programming_tables.sql`), but naming isn't uniform (`007_contact_ledger.sql`, `008_sms_consent.sql`). Read the table's migration before changing its policies.
- Server writes use the service-role key, which bypasses RLS. The Twilio webhooks (including `session_feedback`) write through the API server, not as anon.

**messages table**
- Every insert must set `player_id`: the live column is NOT NULL (verified against production 2026-10-09). Rows with no player don't belong in `messages`: operator test texts live in `operator_test_messages` (migration 030), and their Twilio receipts arrive with `operator_test_id` and are handled before any player logic in the status webhook.
- `contact_ledger` live CHECKs (verified 2026-10-09): `channel` in (sms, email); `purpose` in (promotion, cancellation, other); `outcome` in (booked, opted_out, no_response) or NULL. The live table matches `migrations/007_contact_ledger.sql`, not `artifacts/api-server/migrations/007_experiments.sql`. Don't write other values.
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
- Every outbound text is approved before it sends. Since 2026-11-24 (Ari), Learn to Play texts (steps 1 and 2) are approved by the nightly auto-approver (`src/lib/retentionAutoApprove.ts`, recorded as `approved_by = auto-approver`) when `RETENTION_AUTO_APPROVE=true` and live SMS is on. It uses the same `approveCandidate` checks as the dashboard, schedules for 3:00pm ET (`RETENTION_AUTO_SEND_TIME`), and caps at 25 per ET day (`RETENTION_AUTO_APPROVE_DAILY_CAP`); anything it can't approve stays a draft for the operator.
- Learn to Play follow-up: max 2 texts. Text 1 is a thank-you plus promo code `LTPNEXT25`, plus a next beginner program if one exists (skip the suggestion if none). Text 2 goes 7 days later if they haven't booked, with no promo code. Booking moves the player to the next flow.
- Lapsing-regular win-back (2026-11-24, `src/lib/winbackRules.ts`, `src/lib/winback.ts`, migration 032): regulars (4+ visits in 60 days) overdue by max(14, 2x their median gap) and at most 30 days since their last visit. One text, no promo code, fixed templates naming the next session of their usual program within 6 days, else a generic nudge with the booking page. 20% holdout, 90+ days between win-back texts, skip anyone booked, in the LTP follow-up, texted in 7 days or twice in 30. Manual approval at launch; auto-approve only with `RETENTION_AUTO_APPROVE_WINBACK=true`.
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

- **Production-direct, dry run first.** Ari's decision (2026-10-12): no dev or backup Supabase copy; iterate on the production project. Before merge, code still passes typecheck and the automated suites, including the throwaway-Postgres SQL tests. Every schema migration ships with a `verification/NNN_dry_run.sql` that runs the whole migration in production and then raises a deliberate error so nothing is saved (pattern: `artifacts/api-server/verification/031_dry_run.sql`). Run the dry run, read its message, then apply the real migration. Don't re-raise the dev-copy question.
- **Audit before fixing.** Read the relevant code and report what's actually there before changing anything. Runbook items have gone stale before (4 of 5 in the June sweep were already fixed).
- For multi-item tasks, keep items independent and report a per-item status: `CLOSED` / `PARTIAL` / `DEFERRED` / `REVERTED`, with one line of evidence (file:line, query result).
- Stop and ask on anything ambiguous, anything irreversible, and anything touching live sends or production data.
- `pnpm run typecheck` (repo root) must pass before calling a change done.
- Explain findings in plain English from a club owner's point of view, not just engineering terms.
- After significant work, update `RUNBOOK.md` (changelog plus open items). Schema changes go in a new numbered migration under `artifacts/api-server/migrations/`.

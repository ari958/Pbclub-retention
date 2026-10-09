# Pulse — Operations Runbook

## Pre-launch blockers (must clear before SMS_LIVE=true in production)

These items must all be resolved before flipping `SMS_LIVE=true` in the
production environment. Each has been verified or discovered during development
as of 2026-06-07.

---

### 1. PUBLIC_API_URL must point to the production URL

`PUBLIC_API_URL` must be set to the **production** public URL (Railway per this
runbook), **not** the dev `janeway.replit.dev` URL.

The dev URL sleeps and sits behind the Replit dev proxy, so Twilio status
callbacks to `/api/messages/webhook/status` fire unreliably or not at all.

**Symptom if wrong:** messages send (real Twilio SID returned) but
`delivery_status` / `error_code` stay `null` forever — the carrier verdict is
invisible to the DB.

**Verified 2026-06-07:** with `PUBLIC_API_URL` unset, SID `SM08e6f05bad1db908829fb3d224947f9d`
showed error 30034 in the Twilio Console but `null` in our DB.

**How `twilio.ts` composes the callback URL:**
```ts
const statusCallbackUrl = process.env.PUBLIC_API_URL
  ? `${process.env.PUBLIC_API_URL}/api/messages/webhook/status`
  : undefined;
```
If the env var is absent, `statusCallback` is silently omitted from the Twilio
API call and no webhook is ever sent.

---

### 2. SMS_TEST_OVERRIDE_TO must be CLEARED before real members receive texts

While `SMS_TEST_OVERRIDE_TO` is set, **every** outbound `to` address is
rewritten to that number — production messages would silently redirect all
member texts to the test phone (+12013702546).

Clear the secret (delete or leave unset) as the final step before real rollout.

---

### 3. SMS_LIVE must be explicitly set to `"true"` in the prod environment

The server defaults to dry-run everywhere. Only the exact string `"true"`
activates live sends. An unset, empty, or `"false"` value stays dark.

Since 2026-10-09, `SMS_LIVE=true` is not enough on its own: live sends also
need `SCHEDULER_ENABLED=true` and `NODE_ENV=production` (see the kill switch
below). A server with `SMS_LIVE=true` and any `NODE_ENV` other than
`production` refuses to start.

---

### 4. A2P 10DLC campaign must be APPROVED

Confirmed blocker as of 2026-06-07: unregistered sends return carrier error
**30034**. No code change overcomes this — it is a carrier-level registration
requirement. The campaign must be fully approved in the Twilio Console before
any real member receives a text.

---

### Acceptance test (first prod send)

With `SMS_TEST_OVERRIDE_TO` still pinned to the test number, flip `SMS_LIVE=true`
and send to Ari (`de957a6c-66f0-4e1f-8d30-fd5e3187fef7`). A `delivery_status`
of `"delivered"` (not error 30034) is the green light. Then clear
`SMS_TEST_OVERRIDE_TO` for real rollout.

---

## Scheduler and live-SMS kill switch (`SCHEDULER_ENABLED`)

`SCHEDULER_ENABLED` marks the one live instance. It defaults to off. The
scheduler, queue poller, watchdog and every live SMS send require all of:

- `NODE_ENV=production`
- `SCHEDULER_ENABLED=true` (exact string)
- `RUN_BACKGROUND_JOBS=true` for background jobs; `SMS_LIVE=true` for texts

Set `SCHEDULER_ENABLED` **only as a variable on the live service**. Never put it
in any committed file: committed config is inherited by every fork, staging copy
and second service, which is exactly what this switch exists to stop. Two
services on the same Supabase project cannot both run the scheduler (database
lease), but set it on one service at a time anyway.

To check: the `Server listening` boot log shows `scheduler_designated` and the
effective `sms_live`. A production instance without the secret logs a warning,
starts the API normally, and runs no jobs and sends nothing.

Code: `artifacts/api-server/src/lib/backgroundEnvironment.mjs`
(`schedulerDesignatedForEnvironment`, `liveSmsAllowedForEnvironment`,
`nonProductionLiveSmsError`), used through `smsLiveEnabled()` in
`backgroundPolicy.ts`.

---

## Hosting (Railway, one service)

Deployed from GitHub `main` on push. `railway.json` sets the build
(`node artifacts/api-server/production-build.mjs`), the start command, the
health check (`/api/healthz`) and **one replica**. The API process serves the
dashboard at `/dashboard`; there is no second service. Pre-launch items 1-4
above predate this and refer to the old Replit setup; the rules still hold.

### Service variables

Copy values from the previous host's secrets. All are read at runtime; the
ones marked (build) are also needed during the build.

| Variable | Value / note |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | Railway sets this; leave unset |
| `PUBLIC_API_URL` | `https://<service domain>` (build: validated) |
| `RUN_BACKGROUND_JOBS` | `true` (build: validated) |
| `SMS_LIVE` | `true` |
| `SCHEDULER_ENABLED` | `true`, set **last**, during cutover (see below) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | (build: preflight) |
| `SUPABASE_ANON_KEY` | (build: compiled into the dashboard) |
| `OPERATOR_PASSWORD` | 16+ characters (build: validated) |
| `ALERT_OPERATOR_TO` | E.164 (build: validated) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | (build: validated) |
| `TWILIO_MESSAGING_SERVICE_SID` | only if a messaging service is used |
| `ANTHROPIC_API_KEY` | the only Anthropic key read |
| `PODPLAY_API_KEY` | |
| `DEFAULT_CLUB_SLUG` | `pb-club` (build) |
| `RETENTION_ONLY_MODE` | `true` |
| `REQUIRE_MARKETING_CONSENT` | `false` |
| `VITE_NAV_MODE` | `retention` (build) |
| `SMS_TEST_OVERRIDE_TO` | unset, except during an operator test |

### Every redeploy

Any merge to `main` or variable change restarts the process. The new process
waits for the old one's scheduler lease to expire (up to 2 minutes), during
which `/api/healthz` reports `background_jobs: false`. Normal; nothing is lost.

### Cutover from Replit (done 2026-10-09)

Completed 2026-10-09 ~14:45 ET: Twilio inbound webhook repointed,
`SCHEDULER_ENABLED=true` set on Railway, Replit unpublished, Railway elected
leader, one operator test delivered, test override removed. The club kill
switch was paused by the operator throughout and left paused afterwards.
Remaining: delete the Replit deployment and archive the workspace after the
first Railway nightly run is confirmed. The steps, kept for reference:

1. Create the service from `main` with every variable above **except**
   `SCHEDULER_ENABLED`. It boots as API + dashboard only. Log in, check
   `/api/healthz` returns `background_jobs: false`, press nothing.
2. Outside the texting window, in this order:
   - Twilio console: point the inbound SMS webhook at
     `https://<service domain>/api/messages/webhook/inbound`. Status callbacks
     follow `PUBLIC_API_URL` automatically.
   - Railway: set `SCHEDULER_ENABLED=true`. Logs show "Background worker
     standby: another process holds the global lease".
   - Replit: stop the deployment. Within ~2 minutes Railway logs "Background
     worker elected".
   - `/api/healthz` shows `background_jobs: true`, `sms_live: true`. Set
     `SMS_TEST_OVERRIDE_TO`, send one operator test from Settings, unset it.
3. Next morning: confirm the nightly run completed, then delete the Replit
   deployment and archive the workspace. It is no longer a dev environment.

Delivery receipts for texts sent by Replit in its final minutes post to the old
URL and are lost; doing step 2 after 7:30pm makes that set empty.

---

## Changelog

- **2026-10-09**: Added the `SCHEDULER_ENABLED` kill switch (above). Routed the
  dashboard's mark-as-read through `POST /api/messages/mark-read`; the anon
  client no longer writes. Milestone and monthly-recap generation now use the
  shared `AGENT_MODEL` (`anthropicConfig.ts`) instead of a hard-coded
  `claude-sonnet-4-5`. Rewrote `CLAUDE.md` against the code.
- **2026-10-09**: Production moved to Railway (`pbclub-retention-production.up.railway.app`); cutover details under "Hosting".
- **2026-10-09**: Removed Replit: `.replit`, artifact configs, the dashboard
  proxy gateway, `post-merge.sh`, the mockup-sandbox package and the Replit Vite
  plugins. Added `railway.json`, pinned Node 22. Production is one Railway
  service; see "Hosting" below for the cutover.
- **2026-10-09**: Operator test messages moved to the new private table
  `operator_test_messages` (migration 030). They never write `messages` or
  `contact_ledger`, whose live constraints rejected them.

---

## Open items

### Broken send paths: must route through approval before enabling

These call `sendViaTwilio` without an approved `messageId`, so
`sendApprovedMessage` (`artifacts/api-server/src/lib/twilio.ts`) always throws
and nothing is sent. They are broken, not gated. Each must create an approved
message row and pass its `messageId` before it is switched on.

- Post-session feedback job: `src/lib/postSessionFeedback.ts` (`sendViaTwilio(player.phone, messageBody)`)
- Feedback reply "retry" auto-reply: `src/routes/messages.ts` (`sendViaTwilio(From, retryMsg)`)
- Feedback reply "thanks" auto-reply: `src/routes/messages.ts` (`sendViaTwilio(From, thanksMsg)`)
- Experiment dispatch: `src/routes/experiments.ts` (`sendViaTwilio(freshPlayer.phone, messageBody)`)

### Operator test message: apply migration 030 before deploying the fix

**Status:** migration 030 applied in production 2026-10-09 (11 columns, RLS
on, `service_role` narrowed to INSERT/SELECT/UPDATE). Deploy the branch, then
press "Send operator test message" once with `SMS_TEST_OVERRIDE_TO` set.

Applying it showed Supabase default privileges grant `service_role` ALL
(including DELETE and TRUNCATE) on every new table, beyond what a migration
grants. 030 now revokes that first. Earlier operator tables (017, 020, 029)
were not re-checked; their migrations grant without revoking, so they most
likely carry the same extra privileges. Audit before changing.

Background, kept for the record:

Production schema query results (2026-10-09): `messages.player_id` is NOT NULL.
`contact_ledger` CHECKs allow `purpose` in (promotion, cancellation, other) and
`outcome` in (booked, opted_out, no_response).

`sendOperatorTestMessage` (`src/lib/operatorTestMessage.ts`) inserts a
`messages` row with `player_id: null`, so it fails at that first insert with
"Cannot record operator test". Twilio is never called, so no text is sent. If
that insert passed, its `contact_ledger` row (`purpose='operator_test'`, JSON
`outcome`) would also be rejected. Its history lookup reads that JSON `outcome`
too. Fix (2026-10-09): operator tests now write only to `operator_test_messages`
(no `messages` or `contact_ledger` row), and their status callbacks update that
table. Approved member sends were never affected: they write
`purpose='promotion'` with no `outcome`.

### Pre-existing test failures (not caused by 2026-10-09 changes)

- `src/lib/__tests__/operatorMonitoring.test.ts`, "watchdog detects stale
  queue…": depends on the wall-clock time of day.
- `src/routes/__tests__/inboundInbox.test.ts`, "unmatched operator alerts…":
  the Supabase mock lacks `.neq`.

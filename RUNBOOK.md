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

Set `SCHEDULER_ENABLED` **only as a Secret on the live deployment**. Never put it
in `.replit`, `artifact.toml` or any committed file: those are inherited by every
remix, fork and second deployment, which is exactly what this switch exists to
stop. When moving to Railway, set it on the Railway service and delete it from
Replit **before** the Railway service starts, so two schedulers never run.

To check: the `Server listening` boot log shows `scheduler_designated` and the
effective `sms_live`. A production instance without the secret logs a warning,
starts the API normally, and runs no jobs and sends nothing.

Code: `artifacts/api-server/src/lib/backgroundEnvironment.mjs`
(`schedulerDesignatedForEnvironment`, `liveSmsAllowedForEnvironment`,
`nonProductionLiveSmsError`), used through `smsLiveEnabled()` in
`backgroundPolicy.ts`.

---

## Changelog

- **2026-10-09**: Added the `SCHEDULER_ENABLED` kill switch (above). Routed the
  dashboard's mark-as-read through `POST /api/messages/mark-read`; the anon
  client no longer writes. Milestone and monthly-recap generation now use the
  shared `AGENT_MODEL` (`anthropicConfig.ts`) instead of a hard-coded
  `claude-sonnet-4-5`. Rewrote `CLAUDE.md` against the code.

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

### Operator test message is broken against the live schema (confirmed 2026-10-09)

Production schema query results (2026-10-09): `messages.player_id` is NOT NULL.
`contact_ledger` CHECKs allow `purpose` in (promotion, cancellation, other) and
`outcome` in (booked, opted_out, no_response).

`sendOperatorTestMessage` (`src/lib/operatorTestMessage.ts`) inserts a
`messages` row with `player_id: null`, so it fails at that first insert with
"Cannot record operator test". Twilio is never called, so no text is sent. If
that insert passed, its `contact_ledger` row (`purpose='operator_test'`, JSON
`outcome`) would also be rejected. Its history lookup reads that JSON `outcome`
too. Fix this before relying on the Settings "Send operator test message"
button. Approved member sends are unaffected: they write `purpose='promotion'`
with no `outcome`.

### Pre-existing test failures (not caused by 2026-10-09 changes)

- `src/lib/__tests__/operatorMonitoring.test.ts`, "watchdog detects stale
  queue…": depends on the wall-clock time of day.
- `src/routes/__tests__/inboundInbox.test.ts`, "unmatched operator alerts…":
  the Supabase mock lacks `.neq`.

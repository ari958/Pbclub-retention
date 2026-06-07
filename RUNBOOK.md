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

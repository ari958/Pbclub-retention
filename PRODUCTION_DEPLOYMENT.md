# Production deployment preparation

## Status and boundaries

Prepared for **Reserved VM (`deploymentTarget = "vm"`), one VM instance**. Autoscale is not acceptable for this app.
Nothing has been published, approved, or sent during preparation. `SMS_LIVE`, the club kill switch, and the configured test recipient override were not changed.
Development `RUN_BACKGROUND_JOBS=false` is set. Production service configuration sets it to `true`; workers additionally require `NODE_ENV=production`.

**Before publishing:** confirm/install migration 017 manually in the existing Supabase database, configure the operator password and operator alert destination, and replace the development `PUBLIC_API_URL` in the production environment. These are not done automatically.

## Production build, processes, and port

Build, from the repository root:

```
node artifacts/api-server/production-build.mjs
```

This builds the dashboard with `/dashboard/` as its base path and then builds the API.
Before compiling, the read-only preflight checks the supplied `OPERATOR_PASSWORD`
and published `PUBLIC_API_URL`. It also requires `ALERT_OPERATOR_TO` when
`RUN_BACKGROUND_JOBS` is exactly `true`, using the same worker configuration
policy as production startup. The build targets production even if the calling
shell has a different `NODE_ENV`. Disabled workers do not require an alert
destination. This checks configuration only: it does not initialize the app,
start workers, check database connectivity/schema, or send an alert. Run the
synthetic offline checks with
`pnpm --filter @workspace/api-server run test:production-preflight`.

API start command:

```
node --enable-source-maps artifacts/api-server/dist/index.mjs
```

The API binds to `PORT=8080` on all interfaces and serves the built dashboard's HTML and static assets behind the login gate.
The dashboard service uses a small forwarding process on port 23183, not a Vite production server or public static hosting. It forwards `/dashboard/` traffic to the API, so assets cannot bypass authentication.
Both processes run in **one Reserved VM instance**; the forwarding process has no jobs or provider credentials of its own.
The design/mockup artifact has no production service.

## Secrets: names only

Required production secrets:

- `OPERATOR_PASSWORD` — new; at least 16 characters. Set a production-only password. Not configured during this work.
- `ALERT_OPERATOR_TO` — new; E.164 operator destination. Not configured during this work.
- `SUPABASE_SERVICE_ROLE_KEY` — existing; keep server-side only. Use the key for the intended existing Supabase project.
- `TWILIO_ACCOUNT_SID` — existing.
- `TWILIO_AUTH_TOKEN` — existing; also validates callbacks.
- `TWILIO_PHONE_NUMBER` — existing approved sender; used for operator alerts as well as outbound texts.

Conditional secrets/settings:

- `TWILIO_MESSAGING_SERVICE_SID` — optional existing transport alternative.
- `SMS_TEST_OVERRIDE_TO` — existing test-only destination. **Do not silently copy/remove it for real member sending.** Retain it for a redirected production smoke test; removing it requires the operator's explicit sending decision. It is unchanged here.
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY`, `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` — retain for existing AI features. Deterministic retention copy does not need an AI request; some parked legacy features do.
- `ANTHROPIC_API_KEY` — alternative only if using the existing direct-provider path rather than the Replit AI integration; do not set both without understanding the existing provider selection.
- `PODPLAY_API_KEY` — optional fallback if the club's server-side stored platform API key is not populated.

Non-secret configuration:

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` — existing public connection settings. The anon key remains embedded in the dashboard because its direct reads have not yet been migrated.
- `PUBLIC_API_URL` — **different in production**: exact published HTTPS origin, no path or trailing slash; never the workspace `.replit.dev` URL.
- `RUN_BACKGROUND_JOBS` — **different**: development `false`, production `true`.
- `NODE_ENV` — development `development`, production `production`.
- `PORT` — API `8080`; dashboard forwarding process `23183`.
- `DEFAULT_CLUB_SLUG`, `RETENTION_ONLY_MODE`, `REQUIRE_MARKETING_CONSENT`, `VITE_NAV_MODE` — preserve current intended application configuration.
- `SMS_LIVE` — preserve the operator's intended value; this work did not change it.

The existing `SESSION_SECRET` is not required by the new opaque server-side operator sessions. It has not been changed or removed.

## Background jobs and database locks

With the flag absent, false, or anything other than exactly `true`, recurring workers do not start. Development workers are prohibited even if that flag is accidentally true.
This covers the queue poller, scheduler, feedback poller, nightly chain, retention generation inside that chain, worker heartbeats, and operator watchdog.
Ordinary request timeouts/provider pacing are not scheduled background jobs.

Startup logs include environment, loaded `RUN_BACKGROUND_JOBS`, effective worker enablement, `sms_live`, override presence (not the destination), and operator-login configuration.

Install:

```
artifacts/api-server/migrations/017_operator_runtime.sql
```

Apply manually through the existing Supabase SQL Editor. Do not point the app at a new database or substitute the local test database.
The migration adds service-role-only runtime telemetry and owner-bound renewable leases. It does not modify approvals, sends, player data, live settings, or existing anon SELECT grants.
Distinct database leases prevent duplicate nightly chains and duplicate queue ticks across processes.
Leases expire after 120 seconds and renew every 30 seconds. Failed/lost renewal terminates the worker rather than letting an old process overlap a replacement.
Missing lock/telemetry schema prevents production workers from starting.

Only production may run these jobs against the shared database. Do not enable a second worker deployment.

## Operator authentication

- `/api/operator/login`: single-password login with an optional operator label.
- Five login attempts per IP per 15 minutes.
- Twelve-hour opaque server-side session; `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`.
- Development uses `SameSite=None` plus same-origin mutation protection to support Replit's cross-site preview iframe; production stays Strict.
- Session survives reload, but an API restart logs the operator out.
- Logout revokes the session on the server, not just in the browser.
- Password changes invalidate existing sessions.
- Pages, static assets, root redirects and API routes are gated.
- Public exceptions: login/session/logout, aggregate health, and the two signature-validated Twilio callbacks.
- Cross-origin browser mutations are refused.
- Approvals and pause/resume use the authenticated session's audit identity plus the login label, not a client-supplied approver string.

Without `OPERATOR_PASSWORD`, the workspace remains locked and login returns a clear setup error. The real operator password was not created or requested in chat.

## Twilio callbacks

No production hostname exists yet: deployment metadata reports this project is unpublished.
After the operator selects the actual production hostname, set `PUBLIC_API_URL` to that HTTPS origin. Exact callback paths:

- Status callback: **`{PUBLIC_API_URL}/api/messages/webhook/status`**
- Inbound: **`{PUBLIC_API_URL}/api/messages/webhook/inbound`**

Configure both as **HTTP POST** in Twilio. The outbound transport also sets the status callback from `PUBLIC_API_URL`.
Do not substitute a development hostname or put `/dashboard` in these callback URLs.
Every callback requires a valid `X-Twilio-Signature` computed against the configured public origin, original path/query, and POST parameters. Invalid signatures return 403 before database processing; missing configuration fails closed.

Existing STOP handling permanently sets `opted_out`, exits active LTP sequences, and cancels unclaimed pending messages.
Other ordinary replies transition active LTP sequences to `paused_reply`.
These handlers now run only after signature validation.

The deployment must be externally reachable for Twilio. The application password gate protects operator pages; platform-level private/password publishing would also block unauthenticated Twilio traffic unless a supported external-access mechanism is configured.

## Health and operator alerts

Public **`/api/healthz`** includes:

- Database reachability and runtime-schema readiness.
- Background-worker enablement.
- Last completed queue tick time.
- Last nightly sync status and time.
- Effective live and paused state.
- Whether the operator alert destination is configured.

It contains no player data, message text, credentials, or provider error details. Database/schema failure returns 503; unknown paused state is null rather than falsely reported resumed.

An operator-only Twilio SMS alert is emitted for:

- Nightly sync failure/cancellation/start failure.
- Nightly sync missing one hour after the scheduled time, including schedules crossing midnight.
- No completed queue tick for 15+ minutes.
- Dispatch failure or provider failed/undelivered callback.
- Kill-switch changes, including changes observed outside this API.

Alerts use `ALERT_OPERATOR_TO`, not a player number or `SMS_TEST_OVERRIDE_TO`. They are independent infrastructure notifications, not approval consumption. They remain disabled in development and are rate-deduplicated in the database.
No actual notification was sent during verification; transport was mocked.

**Outage limitation:** an in-process watchdog cannot notify while the entire VM/API is down. Configure an external uptime monitor for `/api/healthz` if whole-process outage notification is required.

## Direct dashboard-to-Supabase reads — report only

There are **27 direct read call sites** (including fallback queries) across ten modules.
Existing anon permissions and these reads were not changed.

| Module | Call sites (source lines at preparation) | Tables touched, including embedded joins |
|---|---|---|
| `lib/ClubContext.tsx` | 59 | `clubs` |
| `pages/Dashboard.tsx` | 302, 323, 334, 354, 359, 374 | `messages`, `players`, `conversations` |
| `components/Sidebar.tsx` | 140, 165, 174, 183 | `messages`, `players`, `conversations` |
| `pages/Messages.tsx` | 146 | `messages`, `players`, `conversations` |
| `pages/Players.tsx` | 268, 277, 298 | `players`, `session_feedback` |
| `components/PlayerDrawer.tsx` | 207, 212, 218, 227, 272, 432 | `players`, `attendances`, `conversations`, `messages`, `level_taxonomy` |
| `pages/Assessments.tsx` | 119, 135 | `players` |
| `pages/SessionFeedback.tsx` | 135 | `session_feedback` |
| `pages/Settings.tsx` | 566, 570 | `clubs` |
| `components/BulkMessageModal.tsx` | 292 | `message_templates` |

Unique tables: **`clubs`, `players`, `messages`, `conversations`, `attendances`, `level_taxonomy`, `session_feedback`, `message_templates`**.
Some modules are parked under retention-only navigation; their direct read code remains.

**Security consequence:** operator login protects this app's pages/assets/APIs, but does not revoke access via an already-known Supabase anon key. This remains a separate exposure until those reads and grants are changed.

Estimated migration effort: **3–5 focused engineering days**, not including database permission review/approval:
1. Add/reuse club-scoped authenticated read endpoints for metadata, counts, lists, and player detail/history.
2. Replace all direct reads and fallback branches, preserving filters, pagination, counts, embedded joins, and freshness.
3. Exercise active and parked screens under API authentication.
4. Inventory other consumers and RLS policies, revoke anon SELECT on the listed tables, and remove the client Supabase key only after confirming no remaining consumers.
No grants were revoked as part of this preparation.

## Verification results

- **68 backend tests passed**: operator authentication, cookie flags, logout revocation, session-derived audit identity, cross-origin rejection, rate limits, canonical Twilio signatures, worker flags, runtime health, alert thresholds/mocked transport, lock failures, live-off holds/resume safety, and LTP lifecycle/opt-out.
- **12 isolated PostgreSQL assertions passed** for owner-bound leases, overlap prevention, expiry recovery, release/renewal ownership, and service-role-only access.
- API TypeScript check passed.
- Combined dashboard/API production build passed.
- Browser preflight passed on an isolated write-blocking fixture using the real middleware and built dashboard: login, protected assets, authenticated dashboard/reload, secure cookie flags, and logout. No actual approval/send/settings controls were exercised.
- The full dashboard TypeScript check remains blocked by pre-existing missing dependencies in legacy UI components (for example Radix UI, `lucide-react`, and `class-variance-authority`). This was not reported as passing. The actual production dashboard build passed.
- The development app remains login-gated with workers disabled. Operator login and alert configuration are present; actual operator login and alert delivery were not exercised with real credentials/providers.
- Migration 017 is now verified in the application's Supabase database: service-role REST metadata confirms all three RPCs and both tables, and anonymous RPC/table attempts are denied. The operator-provided read-only catalog result confirms service-role privileges, denied anonymous/authenticated privileges, and RLS enabled on both tables. No live migration was run during this preparation.
- Latest live health read: `status=ok`, `db_reachable=true`, `runtime_schema_ready=true`, `background_jobs=false`, `sms_live=false`, `paused=true`, `alerts_configured=true`, `last_queue_tick_at=null`. Startup also confirms operator login configured. Sending settings and the kill switch were not changed.

### Final pre-deployment preparation

- Monique Courts, Joel Mcintosh, Wolfgang Hall, and Bernard Canonigo: stale test candidates and linked messages are now `skipped`, with `context.reason` and message error reason `test_cleanup`. Every write was guarded by the original draft/unapproved/unclaimed state. Two unused capacity reservations attached to those skipped drafts were released after rechecking their unapproved, unclaimed, unsent messages; none remain. Five existing sent test records and five existing audit records were unchanged by cleanup.
- Production generation defaults to the three-day lookback. The live `ltp_followup` playbook has `holdout_pct=0`; shared `REQUIRE_MARKETING_CONSENT=false` remains unchanged. Recipient contact eligibility requires a phone and no opt-out; existing sequence, booking, capacity, and transport checks still apply.
- Stale historical provenance is now a blocker before approval and dispatch, not merely a warning. Drafts expire five days after generation. A verified context rebuild renews that lifetime, but text edits and status changes do not. Existing contexts without a generation timestamp fall back to candidate creation time.
- Backdate/reset test tools still require the explicit test override. Real-player STOP persists opt-out and exits the active LTP sequence; persistence failure returns a retryable error rather than acknowledging success.
- Settings now includes **Send operator test message**, available only with `SMS_TEST_OVERRIDE_TO`. The recipient cannot be supplied by the caller, and the only body is `PB Club production test. No action needed.` It uses the same final live/kill-switch/window/Twilio transport as approved sends, without creating a player, candidate, sequence, or approval.
- Operator tests persist a test-flagged message and ledger audit containing the session-derived actor. SID and receipt status are displayed and refreshed. Signed callbacks can identify an operator test before its SID bookkeeping finishes, and the provider's queued response cannot overwrite an earlier receipt. Receipt persistence errors request a retry.
- **77 focused backend tests pass**, including unset override refusal, live-off and send-window refusal, kill-switch checks before and immediately before transport, test bookkeeping, receipt ordering, freshness, test-tool gates, and LTP opt-out regressions. API type check and combined production dashboard/API build pass.
- The authenticated Settings card passed an isolated, write-blocking browser check with intercepted GET/POST responses: override unavailable/available, exact body, empty payload, mocked SID, queued-to-delivered polling, reload persistence, and readable kill-switch refusal. No operator-test request was forwarded to a provider.
- The full dashboard type check still has 114 pre-existing legacy UI errors, including undeclared Radix/lucide dependencies and existing typing issues. There are no errors in the new operator-test component. This check is not being reported as passing.
- Normal approved-member sends still have a separate pre-existing early-callback correlation risk when Twilio posts a receipt before SID bookkeeping. The new operator-test path is protected. A separate follow-up was proposed for the normal member path; it was not broadened into this preparation.
- Nothing was published, approved, sent through Twilio, or changed in live sending configuration during this preparation. The only live data changes were the four requested test-draft skips and release of their two unused capacity reservations.

## Operator deployment checklist

1. Migration 017 and its permissions are verified. Keep the existing Supabase database and retain the prior retention migrations.
2. `OPERATOR_PASSWORD` and `ALERT_OPERATOR_TO` are configured. Confirm that the required secrets are available to the eventual production service; never copy their values into source code.
3. In Publishing, select **Reserved VM**, one VM instance. Do not select Autoscale or create a separate worker deployment.
4. Select the intended public production hostname. Set production `PUBLIC_API_URL` to its exact HTTPS origin. Do not copy the current workspace URL.
5. Verify the production build/start commands and API port listed above. Dashboard traffic must go through the forwarding service/API, not a public static artifact.
6. Verify development `RUN_BACKGROUND_JOBS=false` and production `RUN_BACKGROUND_JOBS=true`; production `NODE_ENV=production`.
7. Preserve `SMS_LIVE`, kill-switch state, and `SMS_TEST_OVERRIDE_TO` unless the operator separately authorizes a sending-state change. **Publishing with live-on/resumed workers may dispatch existing approved, due messages.** Review the queue and intended sending state before clicking Publish; preparation did not approve or clear anything.
8. When authorized, the operator publishes. This preparation did not publish.
9. Check production `/api/healthz`: database/schema ready, intended live/paused state, and queue ticks advancing within five minutes. Review startup logs for worker enablement and override presence.
10. Verify `/dashboard/` redirects to login; sign in, reload, inspect protected assets, and log out. Confirm unauthenticated APIs return 401.
11. Set the two Twilio POST callback URLs listed above. Unsigned callback requests must return 403. A later provider callback test must use a genuine Twilio signature and separately authorized test message.
12. Review nightly job completion/alerts. Optional real operator-alert delivery testing sends an SMS and therefore requires separate authorization; none was sent here.
13. Add external health monitoring for whole-VM outages if required.


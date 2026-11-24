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

- **2026-11-24**: Chat approvals. `src/lib/approvalKey.ts` adds a narrow
  machine credential: header `x-retention-approval-key` matching
  `RETENTION_APPROVAL_KEY` (Railway, 32+ chars) may only `GET
  /api/retention/approvals` and `POST /api/retention/candidates/:id/approve|skip`;
  every other route still needs the dashboard login, and a request carrying
  the header never falls back to the cookie. Approvals are recorded as
  `approved_by = chat-approval` and go through the same `approveCandidate`.
  The approve route also accepts `send_at_et: "HH:MM"` (8:30-19:30 New York,
  today, must be in the future), used to send win-back texts at 2pm. Rotate by
  changing the Railway variable and the cloud environment's network secret.
- **2026-11-24**: Lapsing-regular win-back flow. Migration 032 seeds the
  `winback_regular` playbook (single-draft, no promo, 20% holdout) and adds
  `retention_winback_create_candidate`, the only writer for win-back rows. A
  player can start a new win-back cycle 90+ days after their last one; the old
  row stays as history, linked through `prelaunch_superseded_by` (which takes
  it out of the one-row-per-player unique index). No existing function, index
  or LTP row changes. Code: `src/lib/winbackRules.ts` (pure rules, templates,
  validator), `src/lib/winback.ts` (nightly run), wired into the nightly job
  after Learn to Play, plus `POST /api/retention/winback/run` (drafts only).
  - The run refuses to draft when attendance data is more than 3 days old
    (status `stale_data`), so a broken sync cannot make every regular look lapsed.
  - Waiting drafts are refreshed each night (new date, live session check) or
    skipped when the player booked, came back, or the draft is 7+ days old.
    Dashboard "Regenerate" is refused for win-back rows by design.
  - Approval goes through the shared `approveCandidate`; `validateRetentionTextBody`
    routes win-back bodies to `validateWinbackText` (opener, link allow-list,
    no promo/price words, no dashes or exclamation points, 320 chars).
  - Auto-approve for win-back is off until `RETENTION_AUTO_APPROVE_WINBACK=true`;
    it shares the 25-a-day cap with Learn to Play.
  - Sizing/baseline query: `verification/lapsing_regulars_sizing.sql`
    (2026-11-24 run: 340 lapses over 26 weeks, 39% back within 14 days, 51% within 30).
- **2026-11-24**: Outage 2026-10-16 to 2026-11-24. The Railway service stopped
  (last worker heartbeat 2026-10-16 12:58 UTC) and a later build failed on a
  missing `PUBLIC_API_URL`; both the build (`production-build.mjs`) and server
  start (`src/index.ts`) require it. No nightly sync, drafts or texts ran for
  5.5 weeks. Detect next time: `SELECT * FROM operator_worker_instances ORDER BY
  last_seen_at DESC LIMIT 3;` and the `jobs` row for `nightly_sync`.
- **2026-11-24**: Auto-approval for Learn to Play texts (Ari's decision;
  replaces "every text is operator-approved"). New
  `src/lib/retentionAutoApprove.ts` runs in the nightly job after step-1 and
  step-2 drafts are generated. It approves each draft through the shared
  `approveCandidate` (moved to `src/lib/retentionCandidateApproval.ts`), so all
  existing checks still apply and dispatch still requires an approved
  candidate. Recorded as `approved_by = auto-approver`.
  - On only when `RETENTION_AUTO_APPROVE=true` (Railway production only) and
    `smsLiveEnabled()`; does nothing while `sms_kill_switch` is on.
  - Sends at 3:00pm ET on the draft's `send_date_et`
    (`RETENTION_AUTO_SEND_TIME`, default `15:00`, clamped to 8:30am-7:30pm).
    If that time has passed when the nightly job runs, the draft is held.
  - Cap: 25 auto-approvals per ET day (`RETENTION_AUTO_APPROVE_DAILY_CAP`).
    Over-cap and failing drafts stay in Approvals for manual review; reasons
    are in the nightly job log and the `auto-approve held drafts` warning.
  - To turn off: set `RETENTION_AUTO_APPROVE=false` on Railway, or flip the
    kill switch to stop all sends.
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
- **2026-10-12**: Migration 031 applied in production after a passing dry
  run. The first dry run had stopped on Windows line endings introduced by
  copy and paste (no production drift); 031 now ignores carriage returns, and
  a re-run duplication bug the new tests found is fixed. Use the branch copy
  of 031, now merged, not the earlier one.
- **2026-10-12**: Retention engine generalization, slice 5 (dashboard; no
  behavior change for Learn to Play). `GET /retention/approvals` now returns
  each playbook with its flow kind, trigger label, verified code, offer phrase,
  booking URL and the flow's default phrase config, filled from the server
  registry when the row predates migration 031 (`describePlaybookFlow`). The
  dashboard decides from that row: `isSequenceCandidate(candidate, playbook)`
  replaces `isLtpCandidate`, the approval card takes a `playbook` prop, the
  approvals page renders one phrase editor per sequence playbook and gates
  cohort rebuild per group, and the local copy of the default phrase config is
  gone. Wording that said "LTP" now says "sequence" or uses the playbook name.
  The one remaining literal is `LTP_FOLLOWUP_KEY`
  (`lib/retentionFlowKeys.ts`), used only by the LTP test tools, the Reports
  default, and as the fallback when a candidate's playbook row is not loaded.
- **2026-10-12**: Retention engine generalization, slices 4 and 6 (routes
  and scheduler; no behavior change). `POST /retention/generate` and
  `POST /retention/regenerate-batch` accept an optional `playbook_key` (must
  name a registered flow; defaults to `ltp_followup`); the OpenAPI spec does
  not list the field yet, so the dashboard keeps sending none.
  `PATCH /retention/playbooks/:key/config` accepts any registered sequence
  flow and validates the phrase slots against that flow's own rules. The
  approvals list matches step-2 cards to their step 1 by playbook and player,
  not player alone. The nightly job iterates `RETENTION_FLOWS` for step-1 and
  step-2 drafting; one flow's failure never blocks the next. The source scan
  in `retentionFlows.test.ts` now covers the four route files and
  `scheduler.ts`.
- **2026-10-09**: Retention engine generalization, slice 3 (server code only,
  no behavior change). The Learn to Play text rules moved behind the flow
  definition: `RetentionTextRules` (`retentionTypes.ts`) carries the trigger
  program label, verified code, offer text and phrase, percentage and booking
  URL; `ltpPhraseBuilder.ts`, `retentionText.ts`, `retentionCoupons.ts` and
  the dispatch recheck in `ltpSequenceLifecycle.ts` take those rules instead
  of literals (Learn to Play stays the default, so every existing call is
  unchanged). `defineSequenceFlow()` in `retentionFlows.ts` builds a flow from
  its rules; `retentionFlows.test.ts` defines a throwaway second flow and
  builds and validates its texts end to end. The engine now refuses to run
  when a `retention_playbooks` row seeded by migration 031 disagrees with the
  flow in code (`assertPlaybookMatchesFlow`). Working rule added to
  `CLAUDE.md`: test in dev before production, always.
- **2026-10-09**: Retention engine generalization, slice 2: migration 031
  (`031_retention_flow_rules.sql`, written, not applied). The sequence RPCs
  from 013/018 and the inbound STOP handler from 028 now read their rules
  (`flow_kind`, trigger program label, verified promo code, offer phrase,
  booking URL) from the `retention_playbooks` row instead of the literal
  `ltp_followup` / `LTPNEXT25` / booking-URL strings. The literal-keyed
  candidate CHECK becomes a trigger. `retentionFlowRulesSql.test.ts` installs
  the real 013 writers, 018 and 031 twice on a throwaway Postgres, re-runs the
  018 reset assertions unchanged, drafts a step 1 for a second sequence flow
  through the same RPC, and proves an inbound STOP exits every sequence flow.
  `RetentionPlaybook` gained the new optional columns. Apply instructions
  under Open items.
- **2026-10-09**: Retention engine generalization, slice 1 (server code
  only, no behavior change). New `src/lib/retentionFlows.ts` is the registry
  of retention flows; `ltp_followup` is the first and only entry and carries
  everything that used to be a literal in the engine: the Learn to Play
  trigger matcher, the `LTPNEXT25` verified code and offer text, the opener,
  the trigger-date format, the booking URL, the phrase-slot config reader and
  the per-step promo rule (step 1 only). `retentionEngine.ts`,
  `retentionContext.ts`, `retentionText.ts`, `retentionDispatch.ts`,
  `ltpSequenceLifecycle.ts`, `twilio.ts` and `queuePoller.ts` now ask the
  registry instead of comparing against `"ltp_followup"`.
  `generateRetentionDrafts`, `regenerateLtpCandidateBatch`,
  `reshuffleLtpCandidate` and `generateDueLtpStep2Drafts` take an optional
  flow key that defaults to `ltp_followup`. `retentionFlows.test.ts` fails if
  a literal key creeps back into those files. Remaining steps are listed under
  "Retention engine generalization" in Open items.
- **2026-10-09**: Operator test messages moved to the new private table
  `operator_test_messages` (migration 030). They never write `messages` or
  `contact_ledger`, whose live constraints rejected them.

---

## Open items

### Win-back flow (2026-11-24)

1. **Migration 032: APPLIED in production 2026-11-24.** Dry run passed
   (`winback_regular / single / enabled=t / holdout=20% / promo=none; Learn to
   Play unchanged`); the apply returned `winback_ready = true`, holdout 20, no
   promo code, booking URL `https://pbclub.podplay.app`. (A first dry-run attempt
   ran only the final check block, a partial selection in the SQL Editor, and
   failed harmlessly with "retention_winback_ready() does not exist".)
2. Two weeks of manual approval, then decide on `RETENTION_AUTO_APPROVE_WINBACK`.
3. Lift report: compare 14/30-day return rates of `winback_regular` drafted+sent
   rows vs `skipped` rows with `context->>'reason' = 'holdout'`. Not yet on the
   Reports page.
4. Not built: "friends signed up" line (buddy notifications are all opted out).
5. Pre-existing test failures, unrelated to retention: `operatorMonitoring.test.ts`
   (watchdog) and `inboundInbox.test.ts` (fake client lacks `.neq`).

### Retention engine generalization (prerequisite for any new flow)

Slice 1 (2026-10-09) moved the server code onto a flow registry. Slice 2
(2026-10-09) wrote migration 031, which moves the database rules off the
literal key. A second flow still cannot be switched on until these are done,
in roughly this order:

1. **Migration 031: APPLIED in production 2026-10-12.** Dry run passed
   (`retention_sequence_ready = true`, 18 candidate rows satisfy the new rule);
   the apply returned `ltp_followup = sequence / Learn to Play / LTPNEXT25 /
   25% off / https://pbclub.podplay.app`. History of the apply below. No dev copy
   (decision 2026-10-12); the dry run stands in for it.
   - **2026-10-12 production dry run failed, nothing saved**: the live
     `retention_create_candidate` does not contain the text 031 expects
     ("Unexpected retention_create_candidate source"). Diagnose with
     `verification/031_source_check.sql` (read-only; one row per 031
     substitution, MISMATCH rows show the live text with `<NL>`/`<TAB>`/`<CR>`
     markers) before changing 031. Result: no drift. All 27 single-line
     searches matched; every multi-line search failed because the pasted copy
     had Windows line endings (CR+LF) while the live functions use LF. The
     repo files are LF; the CRs came in on copy and paste.
   - **Fixed 2026-10-12**: 031 and the source check now ignore carriage
     returns on both sides of every match. The migration test runs the source
     check, the dry run and the first install from CR+LF copies, then asserts
     a clean re-install changes nothing and no edited function contains a CR.
   - **Fixed 2026-10-12**: 031 inserted two blocks twice on a re-run because
     their new text contains the old text. The amend helper now checks for the
     new text first; a test asserts a second install changes no function.
     Apply 031 from this branch, not the earlier copy merged to `main`.
   - **Dry run.** Paste `artifacts/api-server/verification/031_dry_run.sql`
     into the production SQL Editor and run it. It executes the whole
     migration, then raises an error on purpose so nothing is saved. Expect
     `DRY RUN PASSED. Nothing was saved...` followed by
     `ltp_followup = sequence / Learn to Play / LTPNEXT25 / 25% off /
     https://pbclub.podplay.app`. Any other message: do not apply; it names
     the drifted function or the candidate rows that break the new rule.
   - **Apply.** Paste `migrations/031_retention_flow_rules.sql` and run it. One
     transaction; safe to re-run. The final select must print
     `retention_sequence_ready = t` and the same playbook rules.
   - Order relative to the deploy does not matter: old code never reads the
     new columns, and new code fills them from the registry when absent.
   - What it does: adds `flow_kind`, `trigger_program_label`,
     `verified_promo_code`, `verified_offer_phrase` and `booking_url` to
     `retention_playbooks`, seeds `ltp_followup` with the values the functions
     used to hard-code, replaces 013's literal-keyed candidate CHECK with the
     `retention_candidates_sequence_identity` trigger, and amends the
     installed sequence RPCs plus 028's inbound STOP handler in place (same
     `pg_get_functiondef` technique as 015 and 018, so 018's amendment
     survives). Not covered, by design: the LTP test tools (015, 016) and the
     report views (022-025) stay keyed to `ltp_followup`.
2. **Flow-specific text rules**: done in slice 3. What remains LTP-shaped by
   name only: the `ltp_*` module and column names (`ltp_sequence_config`,
   `ltp_text`, `ltp_date`) and the `ltp_followup` test tools. Renaming them is
   cosmetic and touches the dashboard and generated API types; defer.
3. **Routes**: done in slices 4 and 6, except that `lib/api-spec/openapi.yaml`
   does not yet declare the optional `playbook_key` request field on generate
   and regenerate-batch. Add it and run `api-spec codegen` (a deliberate,
   reviewed step; do not run codegen casually) when the dashboard starts
   sending it.
4. **Dashboard**: done in slice 5. Live check PASSED 2026-10-12 (Ari): step
   and sequence badges, one Learn to Play phrase editor, cohort rebuild button,
   Reports default all as before. The check, for future changes:
   the Learn to Play group shows step badges, one phrase editor, the cohort
   rebuild button and (with a test override set) the test tools, exactly as
   before. Do not approve anything as part of the check: in production an
   approval schedules a real text. Generate and rebuild only create
   unapproved drafts.
5. **Scheduler**: done in slice 6; `scheduler.ts` iterates registered flows.

Dry-run and operator approval rules are unchanged throughout; none of this
touches live sends.

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

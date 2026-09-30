# Approved retention rollout

## Database migration

Migration 010 has been applied to the existing application Supabase project, and the running application reports `schema_ready=true`. For an environment where it has not yet been applied, run `artifacts/api-server/migrations/010_retention_approvals.sql` in the **existing application's Supabase SQL Editor**, not Replit's local database. The script runs in a transaction and includes read-only verification queries.

It adds approvals and dispatch claims, coupon attribution, a test-aware ledger, playbooks, candidates, and atomic draft/review functions. It parks old pending, unapproved messages created before the fixed cutoff `2026-09-30T22:09:46Z` as `archived`. It does not delete messages or feature code. Re-running it cannot archive drafts created after that cutoff.

Until this schema is applied, Approvals shows a missing-schema warning and dispatch fails closed. Do not interpret that screen as a successfully completed rollout.

## Acceptance status — 2026-09-30

- The operator's migration verification returned 580 archived messages, 88 sent, 14 skipped, the seeded `ltp_followup` playbook, and zero unapproved pending messages with a send schedule.
- The running app confirms the schema is ready, retention-only mode is enabled, and the operator-phone override is configured.
- Real draft generation returned `created=0`, `skipped=4`, with no errors. Two prospective attendees' verified event dates fall outside the seven-day trigger window. The other two have qualifying first Learn-to-Play attendance, but no phone number in either the application or the live PodPlay user records.
- No test records were created, no messages were approved, and no Twilio sends were attempted. Read-only checks found zero approved pending messages and zero contact-ledger rows.
- Sending was paused for the test and remains paused; `SMS_LIVE=false`.
- The two-message acceptance test remains incomplete. Do not widen the trigger window, fill customer phone fields with the operator override, or bypass eligibility to force it to pass. Operator-only fixtures require explicit authorization and would verify dispatch safety, not real-attendee draft generation.

## Operating rules

- `RETENTION_ONLY_MODE=true` parks feedback automation, milestones/recaps, programming evaluation and experiment dispatch. `VITE_NAV_MODE=retention` hides their pages and parks their direct links.
- Approval is required globally, even if retention-only mode is later disabled. The reviewed body, operator label, and approval timestamp are bound to each message. Editing revokes approval and its schedule. Stale reviews are rejected.
- `REQUIRE_MARKETING_CONSENT=false` implements the requested phase policy: a nonblank phone and no opt-out. The flag does not establish legal permission to text; consent records remain intact.
- Operator names are typed attribution labels, **not authenticated staff identities**.
- Generation creates only pending, unapproved, unscheduled drafts. It checks the player's earliest attendance and the original event's local date, live future bookings, suggested-program availability, and coupon validity. Unverifiable required facts do not become invented context.
- If `LTPNEXT25` is absent, inactive, expired or unverifiable, drafts contain no offer and Approvals warns. No coupon is created or modified automatically.
- Approvals is the place to review each draft beside its facts, edit, skip, approve individually, or bulk-approve an explicit reviewed selection. Approval schedules the next allowed text window.
- Pause sending controls the club's global kill switch. Unverifiable switch reads block sends. Resuming does not approve any messages.
- The shared dispatch helper records every real send. An operator-phone override is a real Twilio send marked `is_test=true`, with `player_id=NULL` and the original player stored only as `intended_player_id`; it does not start that player's contact cooldown.
- `SMS_LIVE=false` is a simulation, not delivery. Simulations do not write contact-ledger rows. Do not consume the two acceptance-test candidates by approving them in simulation mode.
- An ambiguous provider outcome remains claimed for reconciliation, rather than being retried and risking a duplicate. A verified pre-transport policy block can remain pending for a later safe retry.

## Controlled two-message acceptance test

The live test is **not complete** until delivery is observed and the database checks below pass. Mocked safety tests are not a substitute for it.

1. Apply the Supabase migration and verify Approvals reports `schema_ready=true`. Confirm archived legacy rows and the seeded playbook.
2. Keep `SMS_LIVE=false` while generating `ltp_followup` drafts for the last seven days. Review the coupon warning and every selected message's facts. Do not approve yet.
3. Check there are no other approved pending messages due to send. Keep the operator-phone override configured; never expose its value in logs or reports.
4. During an open text window, turn **on** the global kill switch, confirm the operator override is configured, and enable live sending only for this controlled test. Approve exactly the two intended candidates while sending is paused.
5. Wait until their scheduled slots and a queue poll have passed. Verify both are still pending, no texts arrived, and no real ledger rows were created. This exercises the live pause without approving an extra message.
6. Resume sending. Verify exactly those two texts arrive on the operator's phone. Check the other drafts remain unapproved and have no dispatch claim or Twilio SID.
7. Inspect the two ledger rows: `is_test=true`, `player_id IS NULL`, and `intended_player_id` identifies each intended player. Their original contact cooldowns must not change.
8. Return `SMS_LIVE=false` and leave sending paused after the test unless the operator explicitly authorizes the next phase.

Use environment configuration to change live mode, not a shell command that prints secret values. Never expand the test to customer phones because an override or schema check is unavailable.

## Verification commands

```sh
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/api-server exec tsx --test src/lib/__tests__/retention*.test.ts src/lib/__tests__/twilio*.test.ts
pnpm --filter @workspace/dashboard exec node --experimental-strip-types --test src/lib/approvalGuards.test.ts
pnpm --filter @workspace/api-spec run codegen
```

The existing dashboard-wide type check has unrelated missing UI dependencies; that is separate from the retention rollout and must not be reported as passing.
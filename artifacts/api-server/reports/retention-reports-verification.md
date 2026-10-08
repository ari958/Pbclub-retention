# Retention Reports: verification and database handoff

## Safety

The Reports API and page are read-only. No production writes, sends, approvals,
sending-setting changes, or playbook changes were performed during implementation.
SQL tests use disposable PostgreSQL fixtures. Provider tests use in-memory
transports. The development API has background jobs and live SMS disabled;
neither setting was changed.

## Required external Supabase action

Run the complete file
`artifacts/api-server/migrations/022_retention_reports_and_optouts.sql`
in the **existing external Supabase SQL Editor**, before publishing these changes.
Do not use Replit's local `DATABASE_URL`.

The migration adds the private opt-out event table, receipt OptOutType storage,
compatible inbound capture functions, the reporting classifier and three views.
It runs idempotent backfills and service-role-only grants. It does not approve
messages, send texts, or alter sending/playbook configuration. Backfills are
marked permanently non-alerting, including on later webhook replays.

Historical carrier callback times are not currently stored. The backfill uses a
known callback timestamp when available; otherwise it leaves occurred_at null,
never inventing it from a send timestamp. There are currently zero historical
21610 messages in the verified club. Players have no opt-out timestamp, so any
otherwise-unrepresented flag-only backfills likewise retain null occurred_at.
No manual opt-out API route exists; the current flag helper enforces provider
opt-outs rather than providing a manual route.

The migration ends with SELECTs for backfill counts by source (including zero
counts), both view counts, full baseline output, and unattributed opt-outs.
Keep those result sets for final verification.

## Confirmed production reads, 2026-10-08

For the configured PB Club:

| Check | Confirmed result |
| --- | ---: |
| attendances booked_at >= 2026-10-07 | 25 |
| Those rows with non-null coupon_code | 0 |
| Distinct coupon codes | `[]` |
| Existing STOP receipts | 0 |
| Existing messages with error_code 21610 | 0 |
| Currently opted-out players | 0 |
| Distinct stored program names compared | 367 |
| SQL versus TypeScript LTP classifier divergences | 0 |

The SQL classifier was executed in an isolated PostgreSQL fixture against the
367 names read from production; no production SQL function was installed or run.

`playbook_outcomes`, `sms_optouts`, `ltp_baseline`, and `sms_optout_events`
currently return `PGRST205` (absent from the Supabase schema cache).
Production row counts, full baseline output, rendered real-data scorecard,
unattributed opt-outs, and actual inserted backfill totals are therefore
**unverified**, not zero.

## Repeat after applying the migration

This command performs production GET/SELECT reads only:

```sh
NODE_ENV=test RUN_BACKGROUND_JOBS=false SMS_LIVE=false \
  pnpm --filter @workspace/api-server exec tsx \
  src/scripts/verifyRetentionReportsReadOnly.ts
```

Adding `--classifier-parity` repeats the stored-name comparison in a disposable
local fixture. The command never runs external SQL/RPCs or mutation requests.

Then visit `/c/pb-club/reports` in the Dashboard as an authenticated operator and
record the rendered scorecard. Check 30/90/all-time filters, automatic flow
choices, newest-send sorting, separate step funnels, and club-wide opt-outs
independent of the selected flow.

## Completed offline checks

- Both API and Dashboard TypeScript checks passed.
- Dashboard production build passed.
- Real PostgreSQL migration execution and reapplication passed, including
  backfills, booking/step attribution, baseline, classifier parity examples,
  OptOutType/body mismatch enforcement, receipt retries, unknown STOP capture,
  and private grants.
- SELECT-only, club-scoped Reports route and missing-schema 503 tests passed.
- Carrier callbacks and delivery-race tests passed with fake providers.
- Per-event alert tests passed: successful provider-acceptance evidence,
  duplicate suppression, no backfill alerts, and no resend after ambiguous
  provider acceptance.
- Real anonymous Reports API request returned 401; real page displayed the
  operator login gate. Authentication was not weakened to test rendering.
- Browser-only static-build verification passed: error/retry, scorecard,
  independent funnels, sorting, date/flow query filters, full/unattributed
  opt-out text, empty/non-baseline flows, and mobile rendering/scrolling.
  The mobile panels no longer collapse. This is separate from production
  integration and must not be represented as real report data.

### Rendered synthetic fixture only

| Metric | Rendered |
| --- | --- |
| Texted | 2 players/sequences, 3 texts |
| Booked | 1 of 2, 50.0% |
| Baseline | 1 of 4, 25.0% |
| Code redemptions | 1 of 2, 50.0% |
| Replies | 1 of 2, 50.0% |
| Step 1 opt-out | 1 of 2, 50.0% |
| Step 2 opt-out | 1 of 1, 100.0% |
| Club-wide opt-outs | 3 |

Step 1 funnel: drafted 3, approved 2, sent 2, delivered 1, booked 0.
Step 2 funnel: 1 at each stage.

Production integration remains pending migration application.

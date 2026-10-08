# Retention Reports: verification and database handoff

## Safety

The Reports API and page are read-only. No production writes, sends, approvals,
sending-setting changes, or playbook changes were performed during implementation.
SQL tests use disposable PostgreSQL fixtures. Provider tests use in-memory
transports. The development API has background jobs and live SMS disabled;
neither setting was changed.

## External Supabase migration

The user confirmed migration 022 was applied in the existing external Supabase
SQL Editor on 2026-10-08. Subsequent agent GET/SELECT verification confirmed the
views and backfill totals below. The updated application has not been published
as part of this work.

For another environment, run the complete file
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

### Confirmed after migration application

| Check | Confirmed result |
| --- | ---: |
| playbook_outcomes rows | 13 |
| sms_optouts rows | 0 |
| stop_reply backfill events | 0 |
| carrier_21610 backfill events | 0 |
| manual backfill events | 0 |
| Unattributed opt-outs | `[]` |

Full `ltp_baseline` output:

```json
[{"club_id":"c8976e15-e002-4619-bb4b-b1a70f5cd7ab","n_players":140,"n_booked":44,"rate":0.3142857142857143}]
```

The exact Reports router was also exercised against these production views with
SELECTs through an ephemeral, localhost-only GET harness, then closed. Both
30-day and all-time responses passed the generated response validator.

| Metric | Last 30 days | All time |
| --- | --- | --- |
| Sequences | 7 | 13 |
| Texted | 7 | 7 |
| Texts | 8 | 8 |
| Booked | 0 of 7, 0.0% | 0 of 7, 0.0% |
| Baseline | 44 of 140, 31.4% | 44 of 140, 31.4% |
| Code redemptions | 0 of 7, 0.0% | 0 of 7, 0.0% |
| Replies | 0 of 7, 0.0% | 0 of 7, 0.0% |
| Step 1 opt-outs | 0 of 7, 0.0% | 0 of 7, 0.0% |
| Step 2 opt-outs | 0 of 1, 0.0% | 0 of 1, 0.0% |
| Club-wide opt-outs | 0 | 0 |

30-day funnels: Step 1 drafted/approved/sent/delivered 7 each, booked 0;
Step 2 drafted 2, approved/sent/delivered 1 each, booked 0.
All-time Step 1 drafted 11, with the other counts unchanged.

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

The production-read 30-day and all-time snapshots were rendered and verified
with the actual built app through browser-only interception. The scorecards
matched the table above; all-time showed 13 participants and the expected
11/7/7/7/0 and 2/1/1/1/0 funnels.
This does not prove an authenticated request to the running or published Reports
endpoint. Operator authentication remains intact; no credentials or session
mutations were used during verification.

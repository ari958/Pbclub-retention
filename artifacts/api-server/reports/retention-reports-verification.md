# Retention Reports: verification and database handoff

## Safety

The Reports API and page are read-only. No production writes, sends, approvals,
sending-setting changes, or playbook changes were performed during initial implementation.
The subsequent accuracy correction updated only seven existing attendance
coupon_code values, explicitly authorized by the user's conditional backfill request.
No other production records or outreach settings were changed.
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

## Accuracy corrections (supersedes the initial scorecard above)

The schema handoff is `023_retention_report_accuracy_views.sql`, to run in the
existing external Supabase SQL Editor. It changes only views; it has not been
applied by the agent. Do not rerun migration 022 for this correction.

- `playbook_outcomes_audit` retains all rows with explicit `is_test` classification
  from persisted delivery kinds, contact ledger evidence, and test controls.
- `playbook_outcomes` excludes test sequences and unstarted drafts. All records
  remain in their source tables and the private audit view.
- Outcome is `booked`, `in_window`, or `no_booking`. The observation window ends
  at greatest(step1_sent_at + 7 days, step2_sent_at) + 14 days, inclusively.
- A booked sequence counts as closed immediately. Booking and coupon denominators
  exclude `in_window` sequences. With zero closed sequences, rate is unavailable,
  not 0%. The page shows the in-window count and a sortable Outcome column.

### Send audit

Eight provider message GETs verified the actual destination of every send.
Five messages (four sequences) were test deliveries; three messages (three
sequences) went to their respective player's own number.
Every provider destination classification matched the contact ledger's persisted
`is_test` value and message delivery kind. This is send-time evidence, not a
reading of today's override environment.

The only step-2 send was a test. Its test audit records a `backdate` operation at
2026-10-06T12:38:40.228454Z: the original step-1 send was
2026-10-06T12:03:57.006Z, while the effective eligibility clock was set to
2026-09-29T12:03:57.006Z. Original send timestamps were not rewritten.
The step-2 candidate explicitly carries `ltp_test_mode:true`.

Corrected Texted is **3**, not 7. At the verification read, the genuine cohort
has 3 in-window sequences and no closed sequences, bookings, or code redemptions.
These are a projection from verified production reads until migration 023 is
applied, not a claim that the updated production view/page has been verified.

### Coupon evidence and backfill

The signup-only search checked 448 events / 2,598 signup payloads without finding
a coupon code. That was not proof of no coupon use: order inspection found a
confirmed EVENT_SIGNUP order created 2026-10-08T02:07:09.740Z.
Its actual order subtotal is 36, discount is 18, and total is 18, confirming
coupon use rather than merely an unused coupon reference.

Raw GET evidence:

1. `/events/01a11942-6b23-7334-80fb-df7e32dc96ab/signups`:
   `$.items[0].order.id` (locate signup `01a11943-b38f-7334-80fd-209b7ee30e40`;
   array position can vary) points to order
   `6588a9aa-f0ae-5f61-acf0-115b35cb0933`.
2. `/orders/6588a9aa-f0ae-5f61-acf0-115b35cb0933`:
   `$.coupon.id = d96708c3-213b-4bd2-8ba2-8c9b3eefe54b`.
3. `/coupons/d96708c3-213b-4bd2-8ba2-8c9b3eefe54b`:
   `$.code = "AJF50%OP"`.

The signup itself has `coupon:null`, no `couponCode`, and
`summary.couponDiscount:0`. The old mapping at the requested lines read
`booked_at: bookedAt` and `coupon_code: signup.couponCode ?? null`;
bookedAt comes from `signup.summary.invitation.createdDate`.
Only the coupon mapping was changed, not booking timestamp attribution.

The resolver follows the order/coupon references, caches repeated resources,
paces reads, retries a 429 once, and fails explicitly on lookup errors.
It does not infer codes from a discount amount.

The backfill checked all 148 existing club attendance rows with
`booked_at >= 2026-10-01T00:00:00Z`, matched all 148, and changed only seven
`coupon_code` values: three `AJF50%OP` and four `ROBGUYS35%`.
No sync job, player updates, winback updates, or outreach actions were executed.
Each patch used club/player/event identity and compare-and-set conditions.

### Verification of accuracy corrections

- API and Dashboard TypeScript checks and both production builds passed.
- Five focused tests passed: coupon reference resolution/caching/fail-closed
  behavior, real SQL window boundaries/closed denominators/test exclusion,
  view migration reapplication/private grants, original reporting SQL behavior,
  and club-scoped SELECT-only route validation.
- A production SELECT after the backfill confirmed 148 bookings and exactly seven
  non-null codes (three AJF50%OP, four ROBGUYS35%).
- Both development services restarted cleanly; existing background jobs and live
  SMS remain disabled, without changing either setting.
- Running Reports URL still requires operator login. This pass did not authenticate
  or verify the updated page against the live corrected view.
- Migration 023 remains unapplied externally; updated code remains unpublished.

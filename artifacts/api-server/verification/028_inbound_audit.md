# Inbound conversation schema repair

Migration 028 is prepared, **not applied**. It contains only one CREATE OR REPLACE of the six-argument function. Its body is byte-for-byte the function in 022 except `ORDER BY created_at DESC,id DESC LIMIT 1` becomes `ORDER BY opened_at DESC,id DESC LIMIT 1`. No five-argument replacement, grants, tables, views, triggers, settings or playbook changes.

## Function comparison — every repository difference

Compared the original five-argument PL/pgSQL function in 021 with the six-argument PL/pgSQL function in 022:

1. Adds sixth text parameter `p_optout_type`.
2. Adds locals `event_id uuid`, `event_created boolean := false`, and `mismatch boolean := false`.
3. Moves body STOP/START/reply classification before receipt lookup, instead of classifying only new receipts. Keyword sets are unchanged.
4. Extends SID payload-conflict detection: differing non-null stored/incoming provider opt-out types also conflict. Existing club/from/to/body comparisons remain.
5. For existing receipts, computes a provider/body mismatch using incoming-or-stored provider metadata.
6. For existing receipts, fills previously null `twilio_optout_type`, promotes `kind` to STOP when provider metadata says STOP, and clears `processed_at` if the old kind was not STOP so the STOP effects can run. It returns the updated row.
7. For new receipts, computes the provider/body mismatch and lets provider `OptOutType=STOP` override body classification.
8. Adds `twilio_optout_type` to the receipt INSERT and stores the incoming provider value. INSERT formatting changes but other fields/matching semantics are unchanged.
9. After receipt processing, STOP inserts an idempotent `sms_optout_events` record, including unknown/ambiguous senders. Conflict on receipt ID does nothing; an existing event ID is retrieved on replay.
10. Extends returned JSON with `optout_event_id`, `optout_event_created`, and `optout_type_mismatch`; `duplicate` and receipt fields remain.
11. Removes two explanatory comments: advisory-lock replay serialization, and durable receipt/retry processing. This is comment-only.

Unchanged: validation, tenant lookup, advisory lock, phone normalization/unique matching, conversation lookup/creation and inbound message insertion, START flags, STOP flags, LTP transitions, pending-message skipping, processing-error durability, return type, SECURITY DEFINER, and search_path.

**Important live-definition limit:** The original five-argument function checked into 021 also uses `created_at`. Additionally, 022 replaces the five-argument overload with a SQL wrapper calling the six-argument overload with NULL provider metadata. Its function language becomes SQL and its body becomes that delegation; signature/return type/security/search_path remain. Therefore neither checked-in definition proves the operator's working live five-argument body. REST exposes the current six-argument API but not pg_get_functiondef. The optional `028_live_catalog_readonly.sql` retrieves both live definitions and searches live functions/views without mutations. That query has not been run in production.

## Schema audit and every confirmed missing-column hit

Read the production Supabase REST/OpenAPI schema using the existing service role, without RPC execution or data mutation. Inspected 48 advertised table/view definitions. Static scanning covered 646 literal table query chains across runtime code, scripts and uploaded source archives, plus SQL INSERT/UPDATE columns and qualified SQL references. Manually reviewed alias/embedded-relation false positives. Dynamic SQL, dynamically assembled queries, non-advertised schemas and live function/view bodies cannot be exhaustively certified through REST.

| Location | Hit | Disposition |
| --- | --- | --- |
| `migrations/021_sms_inbound_receipts.sql:61` under api-server | conversations ordered by `created_at` in original five-argument function | Historical migration unchanged; 028 deliberately does not replace the five-argument overload. |
| `migrations/022_retention_reports_and_optouts.sql:106` under api-server | conversations ordered by `created_at` in six-argument function | Fixed by superseding function in 028; historical migration unchanged. |
| `src/lib/__tests__/fixtures/optOutWebhookPostgres.ts`, former line 14 | Fixture invented `conversations.created_at` | Replaced with shared production-column fixture. |
| `src/lib/__tests__/inboundSmsSql.test.ts`, former line 21 | Fixture invented `conversations.created_at` | Replaced with shared fixture; tests now invoke corrected six-argument function. |
| `src/lib/__tests__/retentionReportsSql.test.ts`, former line 16 | Fixture invented `conversations.created_at` | Replaced with shared fixture; apply 028 locally before exercising inbound capture. |
| `attached_assets/messages_1777421014205.ts:529` | Archived reply handler orders conversations by `created_at` | Uploaded historical source, not imported runtime code; left unchanged. |
| `src/routes/players.ts:373` under api-server | Legacy winback conversions query filters `messages.club_id` | Confirmed absent in production; not fixed: adding columns/changing app code would violate function-only 028. |
| `src/routes/players.ts:381` under api-server | Legacy winback sent-total query filters `messages.club_id` | Same restriction; left unchanged. |

No additional confirmed missing-column hits were found within the inspected static references. Other `created_at` references on messages/templates/candidates/etc. are valid; `players.club_id` embedded relation filters are valid. `c.first_ltp_at` is a CTE field, not a conversation column; `c.oid`/`c.relrowsecurity` in 013 refer to pg_class, not retention candidates. The new regression test intentionally includes the old ordering as an expected-failure/source-diff assertion.

## Why tests passed; corrected fixture

All three isolated SQL fixtures included the nonexistent `conversations.created_at`, so PostgreSQL could execute the faulty query. Running actual SQL against an invented schema was not production-schema verification.

The shared fixture now has exactly the production's 13 advertised conversation columns: id, player_id, club_id, triggered_by, programs_offered, outcome, outcome_program, attributed_booking, attributed_at, attributed_program, opened_at, closed_at, updated_at. It matches advertised types, defaults, nullability and FK targets. Catalog-only CHECK constraints/triggers are not exposed by REST and are not claimed identical.

The regression first runs unmodified 022 against that schema and requires the actual missing-created_at failure with zero persisted receipts/messages. After local-only 028, reply/STOP/START must succeed. It also checks opened_at ordering, id DESC tie-breaking, unchanged function OID/owner/ACL, unchanged five-argument definition, replay idempotency and no outbound messages.

Signed HTTP tests exercise normal reply, STOP/provider STOP, START, and carrier 21610 through the corrected SQL fixture with fake transport only. The rollback verification script is tested locally with all writes rolled back.

## Rollback-only verification

Use `028_inbound_rollback.sql` in SQL Editor **after** the operator installs 028. It refuses a used zero SID or an ambiguous/non-test target, then exercises reply, STOP and START under savepoints using `SM00000000000000000000000000000000`. Each phase's effects are rolled back; final receipt/message counts must be zero. It does not call the HTTP handler, provider transport or approval RPC. It has not been run against production.

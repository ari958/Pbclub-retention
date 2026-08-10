---
name: SMS consent import
description: Results and schema from the Customers_2026-08-10.csv web-form consent import
---

# SMS Consent Import

## What was imported
- Source: `attached_assets/Customers_2026-08-10_1786396592755.csv` — 1,895 web-form consent submissions
- Match rate: 1,850 / 1,895 = 97.6% (matched by email to players table)
- Phone fills: 394 players gained a new phone number (were NULL before)
- Consent-only updates: 1,455 players already had matching phone — sms_opt_in set true
- Conflicts: 1 — existing phone retained, CSV number NOT written; stored in sms_consent_records for review
- Unmatched leads: 45 (no PodPlay account) — stored in sms_consent_records with matched=false

## New columns on players (migration 008)
- `consent_source` text — 'web_form' for all imported rows
- `sms_consented_at` timestamptz — original submission timestamp (never import date)

## sms_consent_records table (migration 008)
- 1,895 rows total; 1,850 matched, 45 leads
- UNIQUE on (club_id, email) — re-running import is safe (idempotent upsert)
- No club_id column on buddy_pairs table (verified — queries must omit club_id filter)

## Post-import numbers
- Club-wide phone coverage: 1,479 → 1,873 / 2,506 (59% → 74.7%)
- SMS-reachable in eligible pool: 593 → 967
- Cancellation SMS coverage (ever-attended): ~70% → 98.6% (20 ever-attended players without SMS)
- Monthly send budget: 593×2=1,186 → 967×2=1,934 sends/month

## Import script
`artifacts/api-server/src/scripts/importSmsConsent.js` — ESM, idempotent, runs from artifacts/api-server/

## Hard constraints confirmed
- No PodPlay writes; no messages/programming_notifications/contact_ledger writes
- No existing phone numbers overwritten
- No send button built

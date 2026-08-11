---
name: Silent-failure audit (send/ledger paths)
description: supabase-js error handling pitfall + fail-closed policy for ledger/holdout reads + dispatch failure semantics
---

**Rule:** supabase-js NEVER throws on query errors — `try/catch` around a query is dead code. Always destructure and check `error` explicitly.
**Why:** Phase 4.3 audit found every "pre-migration 007" try/catch guard was dead; a ledger read failure would silently blind the contact-budget gate, and a holdout read failure would contaminate control arms.

**How to apply:**
- Reads whose silent failure weakens a safety gate (contact_ledger history, control holdout, active experiments) FAIL CLOSED: log `logger.error` and throw → route 500s.
- Budget-override read failure falls back to defaults {7d cooldown, 2/30d} with a warn (stricter-is-safer).
- Dispatch failure semantics: failed send → no `sent_at`, `reasons.dispatch_failed=true` (cleared on later success), veto_reason note; measurement + pooled-results exclude `dispatch_failed` and `dispatch_simulated`.
- Participant update after a real send is retried once; if it still fails, outcome `sent_unrecorded` is reported so the operator doesn't blindly re-dispatch (double-send risk).
- Dev-only fault injection: `x-fault-inject: twilio:<pid>;ledger:<pid>;update:<pid>` header on POST /experiments/:id/send, ignored when NODE_ENV==='production'.

**Other durable facts (Phase 4.3):**
- Deployed contact_ledger schema DRIFTED from migrations/007: no `notes` column (file has it), extra `updated_at`/`outcome` columns. Migration files ≠ deployed schema; probe before relying.
- Control holdout is the dominant pool reducer: any ready/sent/measuring experiment's control arm (30d window) is excluded from ALL candidate builds — deleting/creating even a scratch experiment visibly shifts pool sizes. Fully delete scratch experiments (participants then experiment row).
- Budget gate verified E2E: cooldown (7d), 30d cap (2), cancellation-purpose exemption all fire correctly against real ledger rows.

---
name: Live sending holds and simulation recovery
description: User-required live-off behavior, safe simulation recovery, and draft timestamp scope.
---

SMS_LIVE=false means hold approved/scheduled messages untouched, not consume them as simulations. When live sending is on and club sending is resumed, all dispatch safety checks must run again. Any simulation feature must be an explicitly separate mode, never inferred from live sending being off.

**Why:** An approved step-2 test was consumed as a simulated send without delivery; the user explicitly requested holding instead.

**How to apply:** Preserve approval, schedule, candidate/sequence state, and dispatch claims while off. Do not use live-off as a test transport.

Enable live SMS for production only; keep development live SMS disabled.

**Why:** The user explicitly approved production-only activation while keeping development off.

**How to apply:** Use environment-specific values rather than enabling a shared live-send flag. Verify the actual club pause state before activation; do not rely on an operator confirmation alone when the database reports sending enabled.

Resetting simulation evidence requires the configured test override and an audit preserving the old approval and simulation evidence. Refuse any actual Twilio SID, delivery evidence, or contact-ledger send. The legacy literal SIMULATED is a placeholder, not a provider SID. Rebuild fresh facts without reusing the previous approval.

**Why:** The user authorized recovering never-delivered simulations, not undoing actual provider sends or bypassing current booking/opt-out checks.

**How to apply:** Use an atomic guarded reset, block approval until fresh context is rebuilt, and leave unrelated sends, test clocks, and settings unchanged.

Fix creation-time sent_at defaults in draft writers with explicit NULL, not by globally dropping the shared default.

**Why:** The user authorized a draft-source correction; a global default change would unnecessarily affect other message writers.

**How to apply:** Correct both installed draft writers and migration sources, preserving the default for non-draft writers.

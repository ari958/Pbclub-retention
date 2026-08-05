---
name: Attendance sync intra-batch duplicate bug
description: Root cause of 13 upsert errors in syncEventAttendance — multi-status signups produce duplicate (player_id,event_id) rows in the same 100-row batch
---

## Rule
Before calling `upsert()` in `syncEventAttendance.js`, deduplicate `pendingUpserts` by `(player_id, event_id)` — keep CONFIRMED/CHECKED_IN over INVALID if both exist.

**Why:** After Phase 2.4 added INVALID to `ATTENDANCE_SIGNUP_STATUSES`, a player who has both a CONFIRMED and an INVALID signup for the same event now generates two rows with the same `(player_id, event_id)` in the 100-row pending batch. PostgreSQL `INSERT ... ON CONFLICT (player_id, event_id) DO NOTHING` handles conflicts with EXISTING rows but cannot handle two new rows in the same INSERT statement that violate the same key. Both rows land in the same batch → error, whole batch of 100 rows fails.

**How to apply:**
- After building `pendingUpserts` per event, check if `(player_id, event_id)` is already in the array before pushing
- Or: deduplicate the array by `(player_id, event_id)` before flushing, preferring CONFIRMED > CHECKED_IN > INVALID
- This fix is needed in `syncEventAttendance.js` before calling `flushUpserts()`

## Evidence
- 13 upsert errors in Aug 5 Phase 2.4 full re-sync, all on `attendances_unique_attendance`  
- 5 errors in Jul 31 nightly (fewer because fewer INVALID events in incremental window)
- Direct single-row upsert for 33d7532b's 2 missing players succeeded → constraint is correctly on `(player_id, event_id)`, issue is within-batch
- 33d7532b manually reconciled (4/4) via direct insert

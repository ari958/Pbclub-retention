---
name: Backtest booked_at reconstruction
description: How the backtest reconstructs signup count at offset, what the corrected FP numbers are (Phase 2.4), and the key segmentation finding
---

## Rule
The backtest reconstructs signup-count-at-offset from `attendances.booked_at`, not from `final_signups`. Using final count inverts the signal — everything looks enrolled at the end, so nothing ever fires.

**Why:** `final_signups` measures enrollment *after* the event. A rule that fires when count < threshold must measure count *at the checkpoint offset*, which requires knowing when each member booked. `booked_at` timestamps exist in the attendances table for covered events.

**How to apply:**
- Load `attendances.booked_at` per event (chunks of 200 event_ids, paginate rows).
- Coverage gate: skip events where `withBookedAt / total < 0.90`.
- Undercount gate: skip archetypes where median `local_atts / final_signups < 0.70`.
- `signupAtOffset = count(booked_at ≤ event_start − offset_hours × 3600s)`.
- Ground truth (Phase 2.4): FP = would-fire AND final_signups ≥ N; TP = would-fire AND final_signups < N.
- Exclude already-cancelled events — their truncated final count cannot score either.

## Phase 2.4 sweep results (Aug 2026, corrected fill + corrected attendance sync)

**⚠️ Phase 2.3 Clinics grid is SUPERSEDED.** The proxy `fill_rate < 0.5` inverted the clinic signal:
- Clinics have capacity ≈ N. A session with final_signups=3 and capacity=4 has fill_rate=0.75 (→ old proxy: "fine", FP) but is actually a TP (3 < N=4). The proxy classified clinics as mostly-FP when they're actually mostly-TP.

**Open Play (Social + Challenge Court + Coach-Guided + Ladies + Queer):**
- n=161 usable events, median 6 rows/event → ±17pp uncertainty
- Live config N=4/T-3h: FP rate **59.6%**, fire rate 32.3%
- Phase 2.3 proxy result (56.6%) was close — proxy happened to approximate ground truth for Open Play
- Best achievable in grid: N=8/T-2h → 20.2% FP; N=7/T-2h → 22.9% FP

**Clinics (60&60, 30&30, Learn to Play, Workshop, Play w/ Pro, S&D):**
- n=76 usable events, median 4 rows/event → ±25pp uncertainty
- Live config N=4/T-3h: FP rate **12.2%** (Phase 2.3 proxy said 90.2% — completely wrong)
- The rule works well for clinics; most fires are correct (87.8% TP rate)
- Best achievable: N=5/T-2h → 0.0% FP (every fire was a TP)

**Three answers for the shadow rule:**
1. FP rate at live N=4/T-3h: **59.6% ± 17pp** for Open Play; **12.2% ± 25pp** for Clinics
2. Phase 2.3 clinic grid superseded by 78pp; Open Play grid moved only 3pp (proxy was OK for OP)
3. Clinic/Open Play separation: **47pp gap, direction REVERSED** — clinics are BETTER than Open Play, not worse
4. Recommended: Open Play → N=6–7 at T-2h (FP 23–35%); Clinics → current N=4 is fine, strengthen if anything
5. Native config: DO NOT clear. Clinics need MORE protection (8 upcoming unconfigured); Open Play needs RETUNING upward (N=6–7)

## Residual undercount (limits the whole result)
- 23.6% of member bookings arrive within T-3h of event start (invisible to T-3h checkpoint)
- 17.1% within T-2h; 10.6% within T-1h
- This is a structural bound: any T-offset checkpoint undercounts by the late-booking fraction
- Reported prominently in backtest response as `reconstruction_note`

## Archetype undercount detection
All archetypes at median ratio = 1.0 in the 120-day window (P2I Feb–Apr events outside window).
The 0.70 threshold is correct for future runs including older data.

## Attendance sync fix (Phase 2.4)
- `syncEventAttendance.js:VALID_SIGNUP_STATUSES` now imports `ATTENDANCE_SIGNUP_STATUSES` from `signupStatus.ts`
- Added INVALID to the set (series-pass clinic participants; Path to Intermediate etc.)
- Full re-sync: +449 net new rows (7,435 → 7,884)
- 6/7 P2I verification events reconcile; `33d7532b` (Mar 23) has 2/4 — upsert batch error, outside 120-day window
- `ATTENDANCE_SIGNUP_STATUSES` ≠ `INACTIVE_SIGNUP_STATUSES` — different purposes, documented in signupStatus.ts

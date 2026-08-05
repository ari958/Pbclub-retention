---
name: Backtest booked_at reconstruction
description: How the backtest reconstructs signup count at offset, what the 120-day FP numbers are, and the key segmentation finding
---

## Rule
The backtest reconstructs signup-count-at-offset from `attendances.booked_at`, not from `final_signups`. Using final count inverts the signal — everything looks enrolled at the end, so nothing ever fires.

**Why:** `final_signups` measures enrollment *after* the event. A rule that fires when count < threshold must measure count *at the checkpoint offset*, which requires knowing when each member booked. `booked_at` timestamps exist in the attendances table for covered events.

**How to apply:**
- Load `attendances.booked_at` per event (chunks of 200 event_ids, paginate rows).
- Coverage gate: skip events where `withBookedAt / total < 0.90`.
- Undercount gate: skip archetypes where median `local_atts / final_signups < 0.70` (series clinics whose INVALID signups aren't synced — separate fix).
- `signupAtOffset = count(booked_at ≤ event_start − offset_hours × 3600s)`.
- Outcome proxy: `fill_rate < 0.5` (ground truth = actual cancellation; see task #10).

## 120-day sweep results (Aug 2026, corrected fill data)

**Open Play (Social + Challenge Court + Coach-Guided + Ladies + Queer):**
- n=161 usable events, median 6 rows/event → ±17pp uncertainty
- Live config N=4/T-3h: FP rate **56.6%**, fire rate 32.9%
- Best achievable: N=2/T-2h → FP rate ~38.9% (within uncertainty band of N=4/T-2h=48.7%)
- Shorter offset (T-2h) consistently beats longer offset at same N

**Clinics (60&60, 30&30, Learn to Play, Workshop, Play w/ Pro, S&D):**
- n=76 usable events, median 4 rows/event → ±25pp uncertainty
- N=4 at any offset: FP rate **90%+** — clinics fill late, rule is almost always wrong
- Separate rule needed; do not apply Open Play thresholds to clinics

**Three answers for the shadow rule:**
1. FP rate at live N=4/T-3h: ~57% for Open Play; ~90% for Clinics
2. Best Open Play threshold: N=2–3 at T-2h (FP ~39–44%); improvement over live is real but within ±17pp band — needs cancellation-outcome ground truth to confirm (task #10)
3. Clinics and Open Play **must have separate rules** — confirmed on corrected data

## Archetype undercount detection
In the 120-day window all archetypes show median ratio = 1.0 (P2I Feb–Apr events are outside the window; May+ P2I uses CONFIRMED lifecycle). No archetypes excluded in the sweep. The undercount threshold (0.70) is correct for future runs when older data is included.

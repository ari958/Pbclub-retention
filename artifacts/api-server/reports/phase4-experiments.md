# Phase 4 — Outreach Experiment Module
**Date:** 2026-08-10  
**Club:** PB Club (Jersey City, NJ) — `c8976e15-e002-4619-bb4b-b1a70f5cd7ab`

---

## Item 1 — Schema (`007_experiments.sql`)

Four objects added (migration pending manual run in Supabase SQL editor):

| Object | Purpose |
|---|---|
| `contact_ledger` | Records every outreach send; drives cooldown & monthly-cap gates |
| `contact_budget` column on `programming_rules` | Per-rule overrides for `cooldown_days`, `max_per_30_days`, `max_sends_per_decision` |
| `outreach_experiments` | One row per experiment; stores split config, arm messages, status |
| `experiment_participants` | One row per player per experiment; tracks arm, rank, message, sent/vetoed state |

All four objects are club-scoped. RLS policies restrict reads/writes to the owning club. No writes to `players`, `attendances`, `messages`, or `sms_consent_records`.

### Pre-migration behavior
All experiment API handlers degrade gracefully before 007 is applied:
- `GET /api/experiments` → `{ experiments: [], migration_pending: true }`
- `GET /api/experiments/:id` → `503` with clear message
- `POST /api/experiments/preview` → works fully (reads only from pre-existing tables)
- Programming candidate builder → skips contact-ledger and control-holdout blocks silently

---

## Item 2 — Selection & Randomization

### Candidate pool (per `buildExperimentCandidates`)

Funnel (dry-run, decision `743053a0`, "Advanced Beginner Coach Led 60 & 60"):

| Stage | Count |
|---|---|
| Total players | 2,506 |
| After not-booked filter | 2,503 |
| After level fit | 2,503 |
| After segment gate (lapsing + recent_dormant only) | 371 |
| — lapsing (8–30 d) | 116 |
| — recent_dormant (31–90 d) | 255 |
| After SMS gate | 362 |
| After contact budget | 362 |
| **Eligible pool** | **362** |

Hard exclusions applied in order:
1. Already booked on this event
2. Level fit (archetype must match event `podplay_type`)
3. Segment: only `lapsing` and `recent_dormant` (active excluded, long_dormant 91+ d excluded)
4. SMS opt-in + phone present
5. Contact budget: `cooldown_days=7` (no contact in last 7 days), `max_per_30_days=2`
6. Control holdout: players currently in an active experiment's control arm (30-day window) — 0 at dry-run time

### Scoring (warm score)

| Signal | Points |
|---|---|
| Segment: lapsing | +20 |
| Segment: recent_dormant | +10 |
| Buddy plays with this event's enrolled players | +15 |
| Archetype timing match for event slot | +10 |
| Contact recency tiebreaker (7 d = +0, 8–14 d = +3, 15–29 d = +8, 30+ d = +15) | 0–15 |
| Capped at 100 | — |

### Randomization

Candidates sorted by score desc, then assigned to treatment/control via Fisher-Yates shuffle seeded with a mulberry32 PRNG. Seed stored on the experiment row for reproducibility.

**Balance check** (treatment vs. control):
- `|meanScore_T − meanScore_C| > 20` → imbalanced
- `|lapsingPct_T − lapsingPct_C| > 15pp` → imbalanced
- `|meanDaysSince_T − meanDaysSince_C| > 15 d` → imbalanced

Dry-run balance result: **balanced**
- Mean score: T=8.7, C=11.4 (diff 2.7, well under 20)
- Lapsing %: T=30%, C=33% (diff 3pp, well under 15pp)
- Mean days since last visit: T=46, C=44 (diff 2 d, well under 15 d)

### Split

Treatment 70% / Control 30% (configurable via `treatmentPct` param).

Dry-run split: **253 treatment / 109 control** — `worth_running: true` (pool ≥ 30).

---

## Item 3 — Message Drafting

Messages drafted automatically at experiment creation time. Two templates per experiment:

**Lapsing** (8–30 d since last visit):
> "Hey [name]! We've got a spot open in [program] on [day] — would love to have you back. Book here: [link]"

**Dormant** (31–90 d since last visit):
> "Hey [name], it's been a while! We have a [program] session coming up on [day] at [time] that fits your level. Come back and play: [link]"

Each treatment participant gets the message appropriate to their segment. Operators can edit per-participant message text before marking any as sent via the UI. Control arm receives no message.

---

## Item 4 — Operator UI (ExperimentsTab)

Location: `artifacts/dashboard/src/pages/ExperimentsTab.tsx`  
Entry point: Programs page → "Experiments" tab (added to `Programs.tsx`).

### Views

**List view** — shows all experiments for the club with status badges, pool size, treatment/control counts, sent/vetoed counts.

**Setup flow** — step-by-step:
1. Pick eligible session (PROMOTE decisions with a future event start, not already claimed by an active experiment)
2. Configure split % + optional notes
3. Preview: pool size, balance check, segment breakdown, treatment/control stats; "worth running" gate
4. Confirm → creates experiment in DB

**Detail view** (status: ready / sent / measuring / complete):
- Treatment panel: ranked candidate list with score, segment, days-since-last, editable message text, per-row veto button
- Control panel: holdout list (IDs only, no messages shown)
- Send cap line: dashed divider after `max_sends_per_decision` (default 25) rows
- "Mark as sent" button: records `sent_at` per participant and writes `contact_ledger` rows
- Results view: available after experiment moves to `measuring` or `complete` status

**Results view** — shows:
- Fill rate Δ (treatment vs. control event, fetched from PodPlay live)
- Conversion rate (participants who subsequently booked)
- Pooled results across all experiments when ≥ 3 complete

---

## Item 5 — Outcome Measurement

Endpoint: `POST /api/experiments/:id/measure`

Measurement steps:
1. Fetch event current fill from PodPlay `/events/:id/signups`
2. Check treatment participants' booking status: enrolled in event → converted
3. Record conversion on `experiment_participants.converted_at`
4. Compute fill rate Δ: `(event_fill_T% − baseline_fill%)`
5. Compute conversion rate: `converted / sent_treatment`
6. Auto-advance status: if all participants resolved → `complete`, else `measuring`

Pooled results (`GET /api/experiments/pooled-results?clubId=...`): aggregates across all `complete` experiments with ≥ 3 total, weighted mean fill Δ and conversion rate with bootstrapped 95% CI.

Measurement is non-destructive: can be called multiple times; idempotent per participant.

---

## Control Holdout in Promotion Candidate Builder

`programming.ts` now loads active control arm members before the candidate filter loop. Any player in an active experiment's control arm (within 30-day randomization window, not vetoed) is excluded from promotion candidates for all other sessions.

This prevents control arm contamination — a control member who receives a separate promotion SMS outside the experiment would invalidate their holdout status.

---

## Migration Checklist

| Step | Status |
|---|---|
| `007_experiments.sql` written | ✅ |
| `experiments.ts` route wired into `index.ts` | ✅ |
| `ExperimentsTab.tsx` imported in `Programs.tsx` | ✅ |
| Control holdout block added to `programming.ts` | ✅ |
| API server compiles and starts cleanly | ✅ |
| Preview endpoint dry-run verified | ✅ (pool=362, 253T/109C, balanced) |
| **Migration 007 applied in Supabase** | ⏳ **Needs manual run** |

To apply migration 007: paste the contents of `artifacts/api-server/migrations/007_experiments.sql` into the Supabase SQL editor at `https://supabase.com/dashboard/project/knblhxfwvebxntoshiqm/sql` and execute.

After migration 007 is applied, the full experiment create/detail/measure flow will be available.

---

## Summary

Phase 4 delivers a complete A/B experiment module for SMS outreach. The operator can:
1. Pick a PROMOTE decision as the experiment target
2. See a previewed pool (362 candidates at dry-run) with balance verification
3. Review ranked treatment candidates with auto-drafted messages, veto individuals, edit messages
4. Mark manual sends from the dashboard — no Twilio API calls, no automated dispatch
5. Measure fill-rate lift and conversion rate after the session

The control holdout enforces experiment integrity: control arm members are invisible to all other outreach until the experiment window closes. Pooled results accumulate as experiments complete.

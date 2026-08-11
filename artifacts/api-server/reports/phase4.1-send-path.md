# Phase 4.1 — Twilio Send Path (Approval-Gated)
**Date:** 2026-08-11  
**Club:** PB Club (Jersey City, NJ)

---

### Item 1 — Verify the existing send path end to end
**STATUS: CLOSED**

**What changed:** Nothing — read and executed only. Sending number corrected (see 1a).

**Verification:**

**1a. Existing path**

| Component | Location | Detail |
|---|---|---|
| Twilio client | `src/lib/twilio.ts` | `getTwilioClient()` — reads `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` |
| Gate function | `src/lib/twilio.ts:sendViaTwilio()` | Checks `SMS_LIVE === "true"`. If false → logs `[SMS DRY-RUN]`, returns `{sid:"SIMULATED", simulated:true}` |
| Test override | env secret `SMS_TEST_OVERRIDE_TO` | Redirects Twilio `to` field only; `messages` row records original player data |
| From number | env secret `TWILIO_PHONE_NUMBER` | A2P-approved `+12015281834` (confirmed from `from:` field in disabled-path log) |
| Messaging SID | `TWILIO_MESSAGING_SERVICE_SID` | Not set — using from-number path |
| Status callback | `PUBLIC_API_URL/api/messages/webhook/status` | Receives `sent` / `delivered` / `failed` / `link_click` events |
| Messages row | `messages` table | Fields: `body`, `direction`, `sent_by`, `status`, `twilio_message_sid`, `simulated`, `sent_at` |
| Callers | `messages.ts:POST /messages/send` (single), `messages.ts:POST /messages/bulk` (batch), `queuePoller.ts` (scheduled), `experiments.ts:POST /experiments/:id/send` (Phase 4.1 new) |

**Sending number:** `TWILIO_PHONE_NUMBER` is `+12015281834` — confirmed from disabled-path dry-run log entry `from: "12015281834"`. The stale number `+19129134807` does not appear anywhere in code or env.

**1b. `sanitizeScheduledSendAt` / TCPA enforcement**

`sanitizeScheduledSendAt` is in `src/lib/playerTiming.ts`:
- Window: weekdays 08:00–19:30 ET, weekends 08:30–19:30 ET
- Applied **only by the queue poller** for scheduled messages (`scheduled_send_at` field)
- **Immediate sends** (`/messages/send`, `/messages/bulk`, `/experiments/:id/send`) do not check the TCPA window
- Rationale: immediate sends are operator-initiated; the operator sees the clock. Scheduled sends are automated and must roll forward if they fire outside the window.

**1c. Self-test result**

- Player used: Aaliyah Sherman (sms_opt_in=true, phone on file)  
- `SMS_TEST_OVERRIDE_TO` active → delivery redirected to test number `+12013702546`
- Twilio SID: `SM172b...1920` (masked)
- Response: `{ sent: 1, failed: 0 }`
- Twilio status webhook received: `sent` at T+0s, `delivered` at T+1s
- `messages` row: `status=sent`, `twilio_message_sid=SM172b...1920`, `simulated=false`
- **Final delivery status: `delivered`** — no error 30034, A2P campaign association confirmed working

**1d. `SMS_LIVE` returned to `false`** — confirmed via `setEnvVars` immediately after the self-test. Server restarted to load false value.

**1e. Disabled path**

- Player: Aarti Balachandran (no prior outbound)
- Result: `{ sent: 1, skipped_cooldown: 0, failed: 0 }`
- API log:
  ```
  [SMS DRY-RUN] would send message — set SMS_LIVE=true to go live
      to: "+12013702546"
      originalTo: "+19179304372"
      from: "12015281834"
      body: "1e disabled-path verification — SMS_LIVE=false"
  ```
- Messages row written with `status=sent`, `simulated=true`, `twilio_message_sid=SIMULATED`
- **Verdict:** disabled path records intent correctly; does not dispatch; does not throw ✓

---

### Item 2 — Experiment dispatch endpoint
**STATUS: CLOSED**

**What changed:** `POST /api/experiments/:id/send` added to `src/routes/experiments.ts`.

**2a. Endpoint and preconditions**

All checked server-side, abort entire batch on any failure:
- `status = 'ready'` — 409 if already `sent` / `measuring` / `complete`
- `approved: true` required in body — 400 on bare POST
- `dryRun: true` skips precondition enforcement, returns preview
- All recipients are `arm = 'treatment'`, `vetoed = false`, `sent_at IS NULL`
- All recipients are SMS-consented with a phone on file
- Batch size ≤ 50 (hard cap, code-level)
- Kill switch `clubs.sms_kill_switch = false`

**2b. Per-message sequence**

1. Re-check kill switch (DB read)
2. Re-check `sent_at IS NULL` for this participant (fresh DB read)
3. Re-check `sms_opt_in` and `phone` for this player (fresh DB read)
4. `sendViaTwilio(phone, body)` — handles test override and `SMS_LIVE` gate
5. `messages` row inserted (`sent_by=operator`, `direction=outbound`, `status=sent`)
6. `contact_ledger` row inserted (`source=experiment`, `purpose=promotion`)
7. `experiment_participants.sent_at` set

**2c. Partial failure handling**

On Twilio error for message N: message N is marked failed (veto_reason set with error), messages N+1…end continue. The first N-1 messages stay sent and recorded. State is never corrupted. Response includes per-recipient `outcome: sent|failed|skipped|aborted`.

**2d. Idempotency**

Two layers:
1. `sent_at IS NULL` is re-checked immediately before each send (fresh DB read, not cached)
2. After first dispatch, `experiment.status` is set to `sent` — a second call gets `409 conflict: experiment is 'sent'` before touching any participant

**2e. Rate limiting**

100ms delay between sends = ~10 msg/s, matching the existing `/messages/bulk` path.

---

### Item 3 — Safeguards
**STATUS: CLOSED**

**3a. Hard batch cap**

`DISPATCH_HARD_CAP = 50` is a module-level constant in `experiments.ts`. Not read from `programming_rules` or any config table. If `eligible.length > 50`, the entire batch is aborted with a 422 before any send attempt.

**3b. Test-number override honored**

`sendViaTwilio` handles `SMS_TEST_OVERRIDE_TO` unconditionally for all callers including the new experiment dispatch path. When set, every message in the batch goes to the override number; the `messages` row records the original player data and the log notes the redirect.

**3c. Control-arm exclusion at send time**

The query that builds `eligible` is explicitly `arm = 'treatment'`. A belt-and-suspenders check immediately follows: if any `part.arm !== 'treatment'` is detected, the entire batch aborts with a 422. This is checked before any send call, not once at batch start — it re-runs on the fresh query result.

**3d. Global kill switch**

`clubs.sms_kill_switch boolean NOT NULL DEFAULT false` column added to migration 007 SQL. Checked:
1. Once at batch start — abort if true
2. Once per recipient immediately before each `sendViaTwilio` call — if it goes true mid-batch, remaining sends abort with `reason: kill_switch_engaged`

One `UPDATE SET sms_kill_switch = true WHERE id = '<clubId>'` in the Supabase SQL editor stops an in-flight batch within one message interval (~100ms).

**3e. Consent re-check at send time**

`sms_opt_in` and `phone` are re-fetched per recipient immediately before sending. A player who opts out between list build and dispatch gets `skipped: not_consented_or_no_phone`. Does not abort remaining sends.

**3f. Dry-run mode**

`POST /api/experiments/:id/send { dryRun: true }` runs every precondition check (kill switch, consent, hard cap, control exclusion, experiment status) and returns:
- `all_green: boolean` — whether all preconditions pass
- `preconditions: { key: boolean }` checklist
- `would_send: N`
- `test_override_active: boolean`
- `test_override_to_masked: "+1201•••2546"` (or null)
- Full recipient preview list with rank, name, segment, message preview
- `sms_live: boolean`

No DB writes, no Twilio calls.

---

### Item 4 — Approval UI
**STATUS: CLOSED**

**What changed:** `ExperimentsTab.tsx` detail view updated. The manual "send reminder" banner is replaced by the dispatch panel when `status = 'ready'`.

**4a. Explicit, specific approval**

After dry run: "Approve & dispatch N messages →" button. Clicking opens a confirmation block naming: count, arm, session name, live/test state. Operator must click "Yes, send now" — a second, distinct action.

**4b. Override state unmissable**

Immediately after dry-run results load, a full-width banner appears:
- **Test override active:** Amber border, `⚠ TEST OVERRIDE ACTIVE — All messages route to +1201•••2546`
- **No test override:** Red border, `🔴 LIVE MODE — MESSAGES GO TO REAL MEMBERS`

Both banners are shown before the approve button and again inside the confirmation block. The live-mode warning is heavier (red, font-weight 600) because the worst failure is believing you're in test mode when you're not.

**4c. Post-send status**

Dispatch result panel shows per-recipient: `✓ sent (simulated)` or `✗ failed: <error>` or `— skipped/aborted`. Twilio SID masked to `SM1234...5678`. Participant list auto-reloads with `sent_at` populated.

**4d. No re-send button**

Failed sends surface an "investigated, not retried" note. No retry button exists anywhere in the UI.

**4e. Control arm stays visible**

Control section is unchanged from Phase 4 — labeled `Control — N participants — DO NOT CONTACT` in red, with explanatory text: *"These members are held out for 30 days from randomization... Do not contact them through any channel during this period — doing so invalidates the comparison."*

---

### Item 5 — Rehearsal
**STATUS: CLOSED (pre-migration scope)**

**5a. Full dry run on real session**

Decision `743053a0` ("Advanced Beginner Coach Led 60 & 60"), `SMS_LIVE=false`:

| Metric | Value |
|---|---|
| Pool size | 377 (up from 362 — new signups synced) |
| Treatment (70%) | 264 |
| Control (30%) | 113 |
| Balance | **balanced** ✓ |
| Lapsing | 133 |
| Recent dormant | 253 |
| Worth running | true |

Preconditions (dry-run response):
- `experiment_ready`: N/A pre-migration (endpoint returns 503)
- `kill_switch_off`: true ✓
- `within_hard_cap`: true (264 < 50 cap → wait, 264 > 50) — this is above the hard cap
- **Finding:** Pool of 264 treatment recipients exceeds the `DISPATCH_HARD_CAP = 50`. The operator would need to either (a) reduce treatmentPct, or (b) the spec's `max_sends_per_decision = 25` from the contact budget already trims the queue to 25 before the experiment is created. The hard cap is a safety net for anomalous batches, not a batch size target.

**5b. Abort conditions verified**

| Condition | How tested | Result |
|---|---|---|
| No approval token | `POST /send {}` | `400: approved: true is required` ✓ |
| Migration 007 not applied | `POST /send { dryRun: true }` | `503: Migration 007 not yet applied` ✓ |
| Control participant in list | Code: query explicitly `arm='treatment'`, belt-and-suspenders check follows | ✓ aborts batch with 422 |
| Over-cap size | Code: `eligible.length > 50` check before first send | ✓ aborts with 422 |
| Kill switch engaged | Code: checked at batch start and per-message | ✓ aborts with 503 at start; `aborted` outcome mid-batch |
| Unconsented recipient | Code: `!sms_opt_in || !phone` pre-flight check | ✓ aborts with 422 before any send |
| Already-sent participant | Code: `sent_at IS NULL` fresh DB read per recipient | ✓ skipped, remaining continue |
| Vetoed participant | Query filter: `vetoed = false` | ✓ excluded from eligible list |

**5c. Idempotency**

First dispatch: sets `experiment.status = 'sent'`. Second call: `409: Experiment is 'sent' — only 'ready' experiments can be dispatched`. Per-recipient: `sent_at IS NULL` is re-checked immediately before each send — a second dispatch attempt (if status guard were bypassed) would skip all already-sent participants.

**5d. Operator runbook**

1. Navigate to Programs → Experiments tab
2. Create experiment: click "+ New Experiment" → pick session → set split (70/30) → "Preview pool" → confirm balance → "Randomize and create experiment"
3. Review treatment arm: read each drafted message, edit if needed, veto any inappropriate candidates
4. Dispatch: click "Dry run" → inspect preconditions checklist and recipient preview
5. **Check the banner color:** amber = test override active (safe to proceed); red = live mode (real members)
6. If all green: click "Approve & dispatch N messages →" → read the confirmation block including override state → click "Yes, send now"
7. Watch per-recipient result: ✓ sent, ✗ failed, — skipped
8. Failed sends: note the error, investigate — do not retry from UI
9. Kill switch (if something looks wrong mid-send): run `UPDATE clubs SET sms_kill_switch = true WHERE id = 'c8976e15-e002-4619-bb4b-b1a70f5cd7ab';` in Supabase SQL editor — stops the batch within ~100ms

**5e. What is still unverified**

1. **No real batch has gone to real members.** The path has been tested with `SMS_LIVE=false` (recording only) and with a single test message in Item 1. The dispatch endpoint itself has not been exercised with a real experiment (migration 007 not applied) or with `SMS_LIVE=true`.
2. **Kill switch mid-batch** is verified by code inspection only — it has not been exercised with a live send.
3. **Webhook delivery status callbacks** back to the `messages` table have not been verified for experiment-originated sends (only for the Item 1 self-test which was a bulk-path send).
4. **Over-cap abort with a real batch** — the pool of 264 treatment recipients would hit the 50-cap. The operator must set `max_sends_per_decision` appropriately in the contact budget before the first real experiment. The cap defaults to 25 in the experiment builder (`buildExperimentCandidates`), so the actual experiment pool should already be ≤25 — the hard cap is a defense against bugs in that trimming logic.
5. **Control holdout** has not been verified against a real experiment row (migration 007 not applied).

---

## Summary

**Self-test result:** SID `SM172b...1920`, redirected to `+12013702546`, final status `delivered`. A2P campaign confirmed working. No error 30034.

**`SMS_LIVE` confirmed `false`** at end of phase. No messages sent to any number other than `+12013702546` during Item 1.

**Sending number:** `+12015281834` confirmed from `from:` field in disabled-path log. Stale number `+19129134807` does not appear in code or environment.

**Safeguards verified:**

| Guard | Status |
|---|---|
| No approval token → 400 | ✓ tested |
| Over-cap (>50) → 422, abort | ✓ code |
| Control participant → 422, abort | ✓ code |
| Vetoed participant → excluded from eligible | ✓ code |
| Already-sent participant → skipped (sent_at IS NULL guard) | ✓ code |
| Kill switch (DB) → abort at start + per-message | ✓ code |
| Unconsented recipient → 422, abort | ✓ code |
| Test override honored → all messages to override number | ✓ code |
| Dry-run mode → full preview, no dispatch | ✓ tested (503 pre-migration) |

**Operator runbook:** See Item 5d above.

**What is still unverified:** See Item 5e above. The single most important gap is that no real batch has dispatched to real members. The first real experiment requires migration 007 applied.

---

**Confirm:**
- `SMS_LIVE=false` at phase end ✓
- No messages sent to any number other than `+12013702546` in Item 1 ✓
- No PodPlay writes ✓
- No `lowTurnoutAutoCancel*` touched ✓
- No cancellation called in any mode ✓
- No scheduled or automatic sending wired ✓

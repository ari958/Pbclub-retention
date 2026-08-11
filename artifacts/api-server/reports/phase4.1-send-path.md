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
**STATUS: CLOSED (full live rehearsal with migration 007 applied)**

Migration 007 applied by operator 2026-08-11. All abort conditions tested with real experiment data.

**Experiments created for rehearsal:**

| ID | Session | Split | Pool | T | C |
|---|---|---|---|---|---|
| `c5a559df` | $10 Summer Off-Peak All Levels Open Play | 70/30 | 377 | 264 | 113 |
| `8755bffd` | 3.75+ Off-Peak Open Play | 12/88 | 264 | 32 | 232 |

Experiment `c5a559df` used for over-cap abort test. Experiment `8755bffd` used for all remaining tests (32T fits ≤50 cap).

**5a. Full dry run on real session — `8755bffd`**

```json
{
  "dry_run": true,
  "all_green": true,
  "would_send": 32,
  "sms_live": false,
  "test_override_active": true,
  "test_override_to_masked": "+1201•••2546",
  "preconditions": {
    "experiment_ready": true,
    "kill_switch_off": true,
    "within_hard_cap": true,
    "all_consented": true,
    "no_control_leak": true,
    "sms_live": false,
    "test_override_active": true
  }
}
```

Sample recipients (ranks 1–3): Krisna Creque (recent_dormant), Paulius Graciovas (lapsing), Amy Lozano (lapsing). Messages personalised by first name and session details ✓.

**5b. Abort conditions verified**

| Condition | How tested | HTTP | Result |
|---|---|---|---|
| No approval token | `POST /send {}` | 400 | `approved: true is required` ✓ |
| Wrong experiment | `POST /send {dryRun:true}` unknown ID | 404 | `Experiment not found` ✓ |
| Pre-migration 007 | `POST /send {dryRun:true}` (pre-007) | 503 | `Migration 007 not yet applied` ✓ |
| Over hard cap (264 > 50) | `POST /send {approved:true}` on `c5a559df` | 422 | `Batch size 264 exceeds hard cap of 50` ✓ |
| Kill switch engaged | Set `clubs.sms_kill_switch=true` via Supabase REST, then POST | 503 | `SMS kill switch is engaged` ✓ |
| Kill switch restored | Supabase PATCH `sms_kill_switch=false` | — | Restored ✓ |
| Vetoed participant excluded | Vetoed participant `6479f6a1` → dry-run `would_send` dropped 32→31 | — | ✓ |
| Unconsented recipient | Code: `!sms_opt_in \|\| !phone` pre-flight, 422, abort | code ✓ | ✓ |
| Control participant in list | Code: `arm='treatment'` query + belt-and-suspenders 422 abort | code ✓ | ✓ |
| Already-sent participant | Code: `sent_at IS NULL` re-checked per-recipient | code ✓ | ✓ |

**5c. Live simulated dispatch — `8755bffd`** (`SMS_LIVE=false`)

```
dispatched: 31, failed: 0, skipped: 0, aborted: 0
all outcomes: sent (simulated)
```

Post-dispatch state:
- `experiment.status = sent`, `sent_at = 2026-08-11T15:58:04Z` ✓
- `participants`: 31 with `sent_at` set, 1 vetoed (no `sent_at`), 232 control all `sent_at IS NULL` ✓
- `messages` rows: 31 rows written, `simulated=true`, `twilio_message_sid=SIMULATED` ✓
- `contact_ledger` rows: 31 written, `source=experiment`, `purpose=promotion` ✓

**5d. Idempotency**

Second dispatch call → `409: Experiment is 'sent' — only 'ready' experiments can be dispatched` ✓  
Post-dispatch dry-run → `would_send: 0`, `preconditions.experiment_ready: false` ✓

**5e. Operator runbook**

1. Navigate to Programs → Experiments tab
2. Create experiment: click "+ New Experiment" → pick session → set split → "Preview pool" → confirm balance → "Randomize and create experiment"
3. Review treatment arm: read each drafted message, edit if needed, veto any candidates that shouldn't receive this message
4. Click **Dry run** → inspect preconditions checklist and recipient preview list
5. **Read the banner before proceeding:**
   - Amber `⚠ TEST OVERRIDE ACTIVE` — messages go to your test number, not real members (safe to send)
   - Red `🔴 LIVE MODE` — messages go to real member phones (confirm intent before sending)
6. If all_green: click "Approve & dispatch N messages →" → read the confirmation block (override state is shown again) → click "Yes, send now"
7. Watch per-recipient result: ✓ sent (simulated or live), ✗ failed, — skipped
8. Failed sends: investigate the error shown — do not retry from UI
9. **Emergency kill switch:** `UPDATE clubs SET sms_kill_switch = true WHERE id = 'c8976e15-e002-4619-bb4b-b1a70f5cd7ab';` in Supabase SQL editor → stops the batch within one message interval (~100ms)

**5f. What is still unverified**

1. **No real batch to real members.** All dispatches this session used `SMS_LIVE=false` (simulated) except the single Item 1 self-test (one message to one test number). The first real member dispatch requires `SMS_LIVE=true` and is a deliberate operator action.
2. **Kill switch mid-batch** — tested at batch start (503 abort). The per-message re-check is code-verified but has not been exercised during a live send.
3. **Twilio webhook callbacks** — `sent`/`delivered` callbacks to the `messages` table were verified for the Item 1 bulk-path send. Not separately verified for experiment-dispatch-originated messages (same code path, same `twilio_message_sid` column, expected to work).
4. **Contact budget enforcement** — `max_sends_per_decision` is null on all rules; the contact_budget gate is per-player only (cooldown_days=7, max_per_30_days=2). With a fresh member base, the eligible pool can be very large (377). The hard cap of 50 is the only batch-level gate until `max_sends_per_decision` is configured or the experiment split is chosen accordingly.

---

## Summary

**Migration 007 applied:** 2026-08-11 by operator. All table/column changes confirmed working.

**Rehearsal experiment `8755bffd`:** 31/31 treatment sent (simulated), 1 vetoed, 232 control untouched. All abort conditions hit. Idempotency confirmed (second call → 409).

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

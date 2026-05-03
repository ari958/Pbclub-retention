# Play By Point vs PodPlay — Gap Analysis for Pulse Onboarding
**Date:** May 3, 2026  
**Scope:** Whether and how Pulse could support a Play By Point (PBP) club, given the current PodPlay-first sync architecture.

---

## 1. Executive Summary

**Play By Point is not viable as a Pulse data source in its current architecture.**

The core problem is architectural, not a matter of missing fields: Pulse is a **pull-based** system. The nightly scheduler calls out to the platform API to import players, fetch events, and build attendance records. Play By Point has no pull API — their only developer interface is **webhooks** (push-based), and even those require manual setup by the PBP team.

This is not a gap that can be papered over with a field mapping. You would have to rebuild the sync layer from a nightly batch model into a real-time event ingestion model, and you would permanently lose the ability to backfill historical data (milestones, streaks, and win-back attribution all depend on months of history).

---

## 2. What Pulse Currently Pulls From PodPlay

| Data Type | Pulse Need | How Pulse Gets It Today |
|---|---|---|
| Full member list | Initial import + nightly refresh | `GET /users` (paginated) |
| Skill ratings | Stored on player profile | `GET /users/{id}/ratings` |
| Event list | All events in a date window | `GET /events` (paginated) |
| Event registrations | Who attended which event | `GET /events/{id}/signups` |
| Membership status | member / non-member segmentation | `user.membershipType` on member fetch |
| Upcoming events | Agent program recommendations | `GET /events` filtered to future dates |

All six of these are **on-demand queries** that Pulse fires at any time. None of them can be replaced by a push webhook.

---

## 3. What Play By Point Actually Provides

### 3a. The Only Interface: Webhooks

PBP's entire developer surface is a webhook system:

- **Setup:** Manual — you submit your endpoint URL, auth credentials, and which facilities to scope. Their team configures it and notifies you when live. No self-serve dashboard.
- **Auth:** Basic Auth or Bearer token on your receiving endpoint. Payload integrity verified via HMAC-SHA256 signature.
- **Versioning:** Every payload includes `event_version` for backwards compatibility.

### 3b. Supported Webhook Event Types

| PBP Webhook Event | What It Carries | Maps to Pulse Need? |
|---|---|---|
| Reservation created/updated/cancelled | Facility reservation details | ⚠️ Court bookings only, not program sessions |
| Membership created | New member signup | ⚠️ New members only — no history |
| Membership renewed | Renewal event | ⚠️ Real-time only |
| Membership cancelled | Cancellation event | ⚠️ Real-time only |
| Payment processed | Transaction record | ❌ Not used by Pulse today |
| Check-in | Member checks into facility | ⚠️ Real-time only — no historical data |

---

## 4. Feature-by-Feature Gap Analysis

### 4a. Initial Player Import — ❌ IMPOSSIBLE

There is no endpoint to query a member list. Pulse cannot bootstrap a new club's player database from PBP. A club switching to Pulse on day one would have **zero player records** until events trickle in via webhooks over time.

**No workaround.** This alone is a launch blocker.

---

### 4b. Skill Ratings (DUPR / Level) — ❌ NOT AVAILABLE

Webhook payloads for check-ins and memberships do not include skill rating fields based on publicly documented payload shapes. There is no ratings API.

**No workaround.**

---

### 4c. Event Attendance History — ❌ NO BACKFILL POSSIBLE

PBP webhooks fire in real time. If a club installs Pulse today, you receive check-in webhooks from today forward. You have no access to:
- Attendance from before integration date
- Event registration history
- Streak seed data

Pulse's milestone engine requires months of attendance history to calculate 10-, 25-, 50-session milestones. Win-back attribution requires knowing when someone last attended. Without backfill, these features are dead on arrival for any existing PBP club.

**No workaround.**

---

### 4d. Event / Program List — ❌ NOT AVAILABLE

There is no API to query upcoming or past events. The agent cannot recommend programs. The Programs page cannot be populated.

Webhooks fire on reservations, not on event creation or event roster changes.

**No workaround.**

---

### 4e. Membership Status — ⚠️ PARTIAL (real-time only)

Membership webhooks (created, renewed, cancelled) can maintain a running state in the Pulse DB once the integration is live. But:
- You have no snapshot of current membership status at integration time.
- You cannot distinguish who is currently an active member vs lapsed without receiving those events from day one.

**Partial workaround:** Ask the club to export a CSV of current members at launch and manually seed the DB. Fragile, not scalable.

---

### 4f. Real-Time Check-In as Attendance Signal — ⚠️ USABLE (future only)

The check-in webhook is the closest PBP comes to the attendance signal Pulse needs. If you build a webhook receiver, check-ins from integration date onward could be recorded as `attendances` rows. This would make streaks and engagement state work — but only for members who have checked in after the integration was set up.

This is not a replacement for the nightly sync model; it is a different operational model with a cold-start problem that cannot be solved.

---

## 5. Architectural Mismatch: Pull vs Push

| Dimension | Pulse / PodPlay | Play By Point |
|---|---|---|
| Data access model | Pull (REST, on demand) | Push (webhooks, real-time only) |
| Historical data | Queryable by date range | Not accessible — past events not replayable |
| Initial sync | Full member + event backfill on onboarding | Not possible |
| Nightly refresh | Re-query all data, update DB | No equivalent — must wait for inbound events |
| Setup | Self-serve API key | Manual, PBP team configures it |
| Reliability | Retry logic under your control | Missed webhooks require PBP to replay (if supported) |

To fully support PBP, Pulse's sync architecture would need to be rebuilt as an event ingestion pipeline. That is a significant engineering investment — and it still would not solve the backfill problem.

---

## 6. Verdict

| Verdict | Details |
|---|---|
| **Short-term (0–6 months):** Not viable | No player import, no history, no self-serve setup. A PBP club could not be meaningfully onboarded onto Pulse. |
| **Medium-term (6–18 months):** Viable with major investment | Build a webhook receiver endpoint, negotiate historical data export with PBP, handle cold-start with CSV seeding. Significant engineering + per-club manual work. |
| **Long-term:** Monitor PBP roadmap | PBP almost certainly has an internal REST API powering their own app. It is worth asking your PBP rep directly whether a partner/private API exists. If so, the picture changes. |

---

## 7. Recommendation

Do not prioritize Play By Point integration. Focus CourtReserve first — it has a mature, self-serve REST API, Swagger docs, and maps cleanly to Pulse's existing pull architecture.

If a specific PBP club requests Pulse, the stopgap is:
1. Ask PBP if they have a private/partner REST API.
2. Ask the club for a historical data CSV export (members + attendance logs) to manually seed Supabase.
3. Build a webhook receiver as a one-off to capture forward-looking check-ins.

This is a significant amount of bespoke work per club and should be priced accordingly.

---

## 8. Comparison Summary: PodPlay vs CourtReserve vs Play By Point

| Capability | PodPlay | CourtReserve | Play By Point |
|---|---|---|---|
| REST API for pulling data | ✅ | ✅ | ❌ |
| Self-serve API key | ✅ | ✅ | ❌ (manual setup) |
| Member list endpoint | ✅ | ✅ | ❌ |
| Event list endpoint | ✅ | ✅ | ❌ |
| Event registrations/attendance | ✅ | ✅ (via reports) | ❌ (check-in webhooks only) |
| Historical data backfill | ✅ | ✅ | ❌ |
| Incremental/delta member sync | ❌ | ✅ | ❌ |
| Skill ratings | ✅ | ✅ | ❌ |
| Membership lifecycle dates | ❌ | ✅ | ⚠️ (webhook events only) |
| Upcoming events for agent | ✅ | ✅ | ❌ |
| Event description for agent | ✅ | ❌ (name only) | ❌ |
| Pulse onboarding viability | ✅ Live | ✅ Buildable | ❌ Blocked |

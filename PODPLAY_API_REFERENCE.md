# PodPlay API v2 — Offline Reference

**Captured:** 2026-07-30 from `https://pbclub.podplay.app/apis/v2/docs-json`
**Spec size:** 452 unique paths, 624 operations, 145 controllers
**Purpose:** offline lookup so API questions can be answered without re-fetching the spec.

> Read §2 first if you have prior assumptions about this API. Several standing project notes are wrong.

---

## 1. Connection basics

| | |
|---|---|
| Base URL | `https://pbclub.podplay.app/apis/v2` |
| Auth | `x-api-key: $PODPLAY_API_KEY` |
| Spec | `GET /apis/v2/docs-json` (NestJS, returns JSON) |
| Swagger UI | `/apis/v2/docs` (robots-disallowed to fetchers; readable in a browser tab) |

**On the `bearer` declaration in the spec:** every one of the 624 operations declares `security: [{bearer: []}]` with scheme `http`/JWT. This is a blanket generated annotation and carries no signal — it appears on endpoints that demonstrably work with `x-api-key`. Browser session cookies are rejected with 401, so JWT is not the live scheme for this surface. Auth is `x-api-key`, full stop.

**Unresolved:** whether the key's *scope* covers mutating admin routes. Reads are proven extensively. The open-invitations auto-create POST was previously disabled pending PodPlay's response (contact: James Lin). Scope on `POST /events/{eventId}/cancellation` is being probed in Phase 0.5.

**Collection envelope.** List endpoints return:
```json
{ "items": [...], "_total": 123, "_links": { "self": {...} } }
```
`_total` counts all matching elements, not just the returned page. Pagination is `page` + `ipp`. Many endpoints accept `expand` to inline related resources.

---

## 2. Corrections to prior project assumptions

These contradict notes currently in the runbook, memory, or earlier session summaries. The spec is authoritative.

**❌ "`GET /events` has no confirmed query params; client-side filtering is more reliable."**
False. It accepts a full param set (§4.1) including `startTime`, `endTime`, `type`, `tag`, `level`, `page`, `ipp`. The 1MB+ payload problem and the 22-minute `sync_events` job are both avoidable. This is probably the single highest-value correction in this document.

**❌ "There is no way to be notified of PodPlay-side changes."**
False. `/outbound-webhooks` supports 79 event types including `event.cancelled.activity`, `event-signup.created`, `event-signup.canceled`, and `event.waitlist.added` (§6). Live push is available; polling for signup counts is optional, not required.

**❌ "Signup count = `signups._total` or `items.length`."**
Dangerous. Signups carry a `status` enum that includes `CANCELED`, and the endpoint takes an `includeCanceled` param. A naive count can overstate real enrollment — which for a low-turnout canceller is an error in the direction that cancels sessions that were actually fine. Always filter to `CONFIRMED` (§5.1).

**❌ "Cancellation may not be exposed via API."**
False. `POST /events/{eventId}/cancellation` is documented and first-class, with a `PREVIEW` dry-run mode (§3).

**⚠️ Waitlist exists as a first-class resource** (§5.2) and was not in the data model. A waitlisted player is a strong signal against cancelling.

---

## 3. Cancellation subsystem

### 3.1 Event cancellation

```
POST /events/{eventId}/cancellation    EventCancellationsController_createEventCancellation
GET  /events/{eventId}/cancellation    EventCancellationsController_findEventCancellation
```

Request body:

| Field | Type | Notes |
|---|---|---|
| `type` | enum | `PREVIEW` \| `ORDER` — **`PREVIEW` is a dry run** |
| `status` | enum | `DRAFT` \| `FAILED` \| `PENDING` \| `CONFIRMED` — marked readOnly |
| `reason` | enum | `WEATHER` \| `LOW_TURNOUT` \| `OTHER` — nullable, marked readOnly |
| `reasonText` | string | free text for `OTHER`, **max 40 chars** |
| `summary` | object | server-computed, see below |
| `disclaimerMarkdown` | string | |

`required: ["type", "status", "summary"]` — but `status` and `summary` are also marked `readOnly`, which is contradictory. This is a NestJS DTO generation artifact; discover the real minimal body empirically via `PREVIEW`.

`summary` contains: `policy`, `policySubtype`, `policyDescription`, `extensionId`, `cancellingUser` (UserProfileDto), `cancellationTime`, `validUntilTime`.

**`validUntilTime` implies a two-phase commit** — preview returns a quote with an expiry, then `ORDER` confirms. For an automated canceller this is close to ideal: preview, log the full consequence, then commit inside the validity window.

### 3.2 Refund policy enum

`summary.policy` ∈
`FREE_OF_CHARGE`, `10MIN_GRACE`, `PLUS_6HS_IN_ADVANCE`, `PLUS_12HS_IN_ADVANCE`, `PLUS_24HS_IN_ADVANCE`, `BETWEEN_12HS_TO_2HS_IN_ADVANCE`, `24HS_OR_LESS_IN_ADVANCE`, `2HS_OR_LESS_IN_ADVANCE`, `FULL_REFUND_VIRTUAL_CREDITS`, `FULL_REFUND`, `NO_REFUND`, `CANCELED_BY_ADMIN`, `TENANT_CUSTOM`

`CANCELED_BY_ADMIN` is presumably what applies to club-initiated cancellation. Note that cash refund (`FULL_REFUND`) and credit refund (`FULL_REFUND_VIRTUAL_CREDITS`) are distinct.

```
GET/POST      /cancellation-policies
GET/PATCH/DEL /cancellation-policies/{id}
```

### 3.3 Related cancellation paths

```
POST/GET /events/{eventId}/signups/{signupId}/cancellation   individual signup
POST     /series/{seriesId}/cancellation                     whole series
POST     /orders/{orderId}/cancellation                      order-level
GET      /orders/{orderId}/cancellations
POST     /suspensions/{suspensionId}/cancellation
POST     /users/{userId}/enrollments/{id}/cancellation        membership
POST     /refunds                                             standalone refund
```

### 3.4 Native low-turnout auto-cancel

Set via `PATCH /events/{eventId}`:

| Field | Type |
|---|---|
| `lowTurnoutAutoCancelAttendeeCount` | number, nullable |
| `lowTurnoutAutoCancelHoursBefore` | number, nullable, **enum: 3, 4, 6, 8, 12, 18, 24, 30, 36** |

Both null on all PB Club events today. **The enum floor of 3 hours is why a custom sub-3h canceller would need its own executor.**

Related member-facing cancellation config on the same PATCH:
- `freeSignupCancellationHorizonHours` (number)
- `signupCancellationFee` (number, nullable)

---

## 4. Events

### 4.1 `GET /events` query parameters

```
startTime, endTime              date filtering
type[], subtype[], customType[] event type filters
tag[], level[]                  tag / level filters
areaId[], regionId[], podId[], tableId[]
name                            name search
page, ipp                       pagination
sort, expand[]
selfOnly, userId                (userId filter is a no-op — confirmed previously)
excludeUnlisted, excludeListed
includeSuspended, includePending
includeCanceled                 include cancelled events
includeCanceledInvitations
excludeClosedSeries
```

### 4.2 `PATCH /events/{eventId}` writable fields

```
name, description, startTime, endTime, guests,
totalTeams, teamSize,
admission, admissionRating, admissionRate, admissionDate, admissionKids,
allowedMemberships, coachRate,
freeSignupCancellationHorizonHours, signupCancellationFee,
lowTurnoutAutoCancelAttendeeCount, lowTurnoutAutoCancelHoursBefore,
tags, picture, visibility, features, status, tournamentDivision
```

`status` ∈ `INVALID` | `DRAFT` | `CONFIRMED` | `PUBLISHED`

Established facts from earlier sessions: price lives in `admissionRate.regular` / `.member`; level gating is `admissionRating` (`minRating`/`maxRating`/`duprConnectedOnly`, DUPR-based); capacity denominator is `totalTeams`; `chargingStrategy: "court+"` makes revenue-per-court-hour unreliable from the API alone.

### 4.3 Event lifecycle paths

```
GET             /events
GET/PATCH       /events/{eventId}
POST            /events/clones            ← only way to create (no create-from-scratch)
POST            /events/{eventId}/reschedules
GET             /events/configuration
GET/POST        /events/invitations
GET/PATCH       /events/recurrence/{recurrenceId}
GET             /events/recurrence/{recurrenceId}/events
POST            /events/{eventId}/settlement
POST            /events/{eventId}/accesses
GET/POST        /events/{eventId}/coaches
GET             /events/{eventId}/payments
GET             /events/{eventId}/reservations
GET             /events/{eventId}/reservations/{id}/sessions
GET/PUT         /events/{eventId}/admission-date
GET/PUT         /events/{eventId}/admission-rate
GET             /events/{eventId}/allowed-memberships
GET             /events/{eventId}/notes
GET/PUT         /events/{eventId}/notes/{noteId}
POST            /events/{eventId}/chat/channels
```

### 4.4 Series & templates

```
POST            /series
GET/PATCH       /series/{seriesId}
POST            /series/{seriesId}/cancellation
GET             /series/{seriesId}/events
GET             /series/{seriesId}/signups
GET             /series/{seriesId}/notes
POST            /series/{seriesId}/settlement
DELETE          /series/{seriesId}/visibility-schedules

GET/POST        /templates
GET/PATCH/DEL   /templates/{id}
POST            /templates/{id}/rollback
GET             /templates/{id}/versions
POST            /templates/from-event/{eventId}
POST            /templates/from-series/{seriesId}
```

`/templates/from-event/{eventId}` is worth investigating — it may be a cleaner publish path than clone-then-patch.

---

## 5. Signups, waitlist, attendees

### 5.1 Signups

```
GET/POST  /events/{eventId}/signups          params: includeCanceled, expand
GET       /events/{eventId}/signups/{signupId}
GET/POST  /events/{eventId}/signups/{signupId}/cancellation
POST      /events/{eventId}/signups/{signupId}/modifications
POST      /events/{eventId}/signups/payments   (approx path — verify)
```

Signup object fields:
```
id, type, status, mode, paymentMethod, virtualCredits, couponCode,
passesStrategy, termsAgreed, liabilityWaiverAgreed, availableGuests,
guests, kids, coupon, summary, owner, paymentSession,
terminalCollection, order, _links
```

- `status` ∈ `DRAFT` | `INVALID` | `PENDING` | `CONFIRMED` | `CANCELED` | `REQUIRES_AUTHENTICATION` | `PROCESSING`
- `type` ∈ `PREVIEW` | `ORDER` (same two-phase pattern as cancellation)
- `mode` ∈ `USER_BOOKED` | `FREE_OF_CHARGE`
- `paymentMethod` ∈ `CASH` | `CARD`
- **`owner` is an object containing `id` only** — no email or phone inline. Notification requires either N per-user lookups or a local cache.
- `guests` matters: one signup may represent more than one body on court. A confirmed-signup count is not necessarily a head count.

**Correct enrollment count:** filter `items` to `status === "CONFIRMED"`, and decide explicitly whether to add `guests`. Do not use `_total` or `items.length` naively.

### 5.2 Waitlist

```
GET/POST/PATCH  /events/{eventId}/waitlist
GET/DELETE      /events/{eventId}/waitlist/{waitlistedUserId}
```
`WaitlistController_findWaitlistedUsers`, `_createWaitlistedUser`, `_patchWaitlist`.

Relevant to cancellation rules: a session under threshold but with a waitlist is a promotion opportunity, not a cancellation.

### 5.3 Attendees, no-shows, check-in

```
GET       /events/{eventId}/attendees        historical — distinct from signups
GET       /events/{eventId}/no-shows
POST      /events/{eventId}/no-show-charges
GET/POST/DELETE  /events/{eventId}/invitations/{invitationId}/check-in
POST      /events/{eventId}/participants
POST      /events/{eventId}/pa...            (BookingParticipantsController)
```

---

## 6. Outbound webhooks

```
GET/POST          /outbound-webhooks
GET/PATCH/DELETE  /outbound-webhooks/{outboundWebhookId}
GET               /outbound-webhooks/events     lists available event types
```

Create body: `displayName`, `url` (HTTPS required in production), `eventTypes[]`.

### Event-related types (of 79 total)

```
event.created                     event.updated
event.fields.updated              event.rescheduled
event.created.activity            event.cancelled.activity     ← cancellation detection
event.settled
event-signup.created              event-signup.canceled        ← live enrollment tracking
event.attendee.added              event.attendee.removed
event.attendee.guests-modified
event.waitlist.added              event.waitlist.removed
event.waitlist.reordered
event.coach.added                 event.coach.removed
event.court.added                 event.court.removed          event.court.updated
event.no-show.charged
series.created.activity           series.fields.updated
series.cancelled.activity         series.settled
series.visibility-schedule.removed
booking.created
```

### Other types

```
user.created / .updated / .deleted / .blocked / .unblocked
user.name.changed / .phone-number.changed / .email.changed
user.gender.changed / .birthday.changed
user.payment-method.added / .changed / .removed
user-kid.created / .updated / .deleted
user-area.added / .removed          user-roles.updated
purchase.created                    order.confirmed / order.canceled
membership-enrollment.created
membership.created / .updated / .deleted
membership-subscription.created / .canceled / .reactivated / .paused /
  .unpaused / .updated / .upgraded / .downgraded / .plan-switched
package.assigned / .redeemed / .canceled / .updated
package.item.refunded
package-template.created / ...
```

**Architectural implication.** `event-signup.created` + `event-signup.canceled` let you maintain a live enrollment count in Supabase without polling. `event.cancelled.activity` tells you when PodPlay cancels something — including its own native auto-cancel. `user.phone-number.changed` and `user.email.changed` keep the local contact cache fresh, which is the mitigation for the missing-email problem in §5.1.

---

## 7. Notification & messaging

```
POST  /custom-emails
GET   /custom-emails/config
POST  /events/{eventId}/open-invitations/{openInvitationId}/emails
POST  /events/{eventId}/open-invitations/{openInvitationId}/smses
GET/POST /voice-messages
POST  /webhooks/events/reminder
POST  /webhooks/events/summary
```

`POST /custom-emails` body:
```
subject          string, max 100 chars
bodyHtml         complete WYSIWYG HTML body
recipients       collection of strings
context          object
bccEmails
recipientSource
sentCount, skippedCount, clubEmailSent, createdDate, status   (readOnly)
```

This is a first-party email send path. If it accepts arbitrary recipients scoped to the club, cancellation notification could go through PodPlay rather than a separate email provider — worth evaluating before building one. `sentCount`/`skippedCount` implies it reports delivery outcomes.

`/events/{eventId}/open-invitations/{id}/smses` is a PodPlay-side SMS path. Note it would ride PodPlay's sender identity, not the PB Club Twilio number — different consent and branding implications, and it sidesteps the A2P campaign entirely. Worth understanding before assuming Twilio is the only SMS route.

---

## 8. Users

```
GET/POST        /users
GET/PATCH/DEL   /users/{userId}
GET             /users/current
GET             /users/{userId}/profile
GET             /users/{userId}/profile/dupr
GET             /users/{userId}/profile/picture
GET/PUT/DELETE  /users/{userId}/phone-number
GET/PATCH       /users/{userId}/preferences
GET             /users/{userId}/contacts
GET/PUT/DELETE  /users/{userId}/notes
POST/DELETE     /users/{userId}/activation
GET             /users/{userId}/activity-feed
GET/POST        /users/{userId}/agreements
GET             /users/{userId}/agreements/required
PUT/POST        /users/{userId}/areas
GET/PATCH       /users/{userId}/chat
POST/DELETE     /users/{userId}/coach-profile
POST            /users/{userId}/devices
PUT             /users/{userId}/dupr-overrides
POST            /users/{userId}/dupr/logout
GET             /users/{userId}/enrollments
GET             /users/{userId}/feature-flags
GET/POST        /users/{userId}/kids
GET/POST        /users/{userId}/memberships
GET/POST        /users/{userId}/packages
GET             /users/{userId}/packages/history
GET             /users/{userId}/payment-elements
GET             /users/{userId}/payment-method
GET             /users/{userId}/favorite-replays
GET/POST        /users/{userId}/virtual-credits-transactions
POST            /users/{userId}/expense-reports
POST            /users/imports
POST            /users/imports/stripe
```

`GET /users/{userId}/preferences` is worth inspecting — it may carry communication opt-ins including the `smsMarketingOptIn` field noted as absent from the live response for the test player.

---

## 9. Remaining path index by domain

Areas not directly relevant to this project, recorded for completeness.

**Analytics & insights**
```
/tenants/current/analytics/revenue | /users | /users/{userId} | /utilisation
/tenants/current/insights/dashboards ...
/tenants/current/insights-runtime/dashboards/{slug} ...
/tenants/current/ai/insights/chats | /analytics/answer | /dashboards/draft | /usage
/tenants/current/status/replays | /status/revenue
/reports, /reports/{id}, /dashboard-filters
```

**Commerce & payments**
```
/orders, /orders/{orderId}/authentication|confirmation|passes|virtual-credits-transactions
/payments/{paymentId}, /payments/{paymentId}/order|receipts|stripe/{id}
/payment-sessions/{id}, /attempts, /cancel
/payouts/{stripeAccount}, /{payout}, /reconciliation, /sync
/refunds, /transfers/{transferId}/reverse
/settlements, /settlements/{id}/receipts
/coupons, /coupons/{couponId}/eligible-users|summary
/gift-cards/redeem
/virtual-credits/redemptions, /{id}/cancel|sync, /pending
/taxes/categories
/psp/callback, /direct-checkout/bookings
```

**Memberships & packages**
```
/memberships, /{id}/areas|benefits|settings|one-time-price-options
/memberships/{id}/has-or-had-members|subscriptions-count
/membership/jobs/capture, /membership/jobs/{jobId}
/package-templates, /{id}/archive|unarchive|grants
/package-template-groups, /packages/{packageId}, /items/{itemId}
/products, /product-offerings
```

**Facilities**
```
/areas, /{areaId}/available-coaches|branding|cms-cameras|pods|settings|locker-rooms
/areas/closest, /regions, /regions/{id}/areas|settings, /regions/closest
/pods, /{podId}/rates|settings|tables|closed-time-overrides|holiday-schedules
/pods/{podId}/tables/{tableId}/devices|settings|voice-downs
/pods/pdk-devices, /pods/verkada-doors
/locker-rooms, /sessions, /sessions/{id}/available-coaches|available-tables
/bookings, /bookings/recurrences, /bookings/{id}/modifications/guests
```

**Coaches**
```
/coaches, /{coachId}/settings, /settings/areas/{id}/availability
/coaches/{coachId}/settings/payments-account
/coaches/{coachId}/students, /coaches/{coachId}/orders
/coaches/tiers, /coaches/tiers/batch
```

**Replays / media / screens**
```
/replays/{replayId}, /replays/{playbackId}/enhance
/events/{eventId}/replays, /{replayId}/likes|retries
/replay-servers/... (config, health, snapshots, versions, branding)
/admin/replays, /screens, /screens/sync, /branding-playlists, /branding-profiles
/assets, /assets/{id}/picture|replace|resize|usage
/cms/branding/resolved|scoreboard
```

**Tenant config & integrations**
```
/tenants/{tenantId}, /admin-settings, /settings, /taxonomies
/taxonomies/event-tags|event-types|event-quick-filters|app-menu|admin-app-menu
/tenants/{tenantId}/integrations/api-keys|discourse|gotab|podcredits|segment|square|swish|verkada
/tenants/current/branches
/api-keys, /api-keys/{apiKeyId}
/agreements, /agreements/liability-waiver|kids-waiver
/audit-logs, /activity-feed, /in-app-messages, /ui/community-events-config
/open-graph/... (events, orders, replays, series, invitations)
/oauth2/token|authorizations|users/credentials|webview-token
/jobs, /jobs/{id}/executions, /jobs/{jobSchedule}/activity-logs
/matches, /matches/batch, /matches/{matchId}/dupr/publish
/suspensions, /terminals, /gotab/... (POS integration)
/proximity-access/login|sync/email|jobs/process-expired
```

**Inbound webhooks (PodPlay receives)**
```
/webhooks/stripe, /webhooks/stripe/connect
/webhooks/events/court-locking|reminder|summary
/webhooks/jobs/executions, /webhooks/users/cleanup|current
/webhooks/replays/cleanup, /webhooks/discourse/notifications
```

---

## 10. Open questions

1. **Cancellation scope for `x-api-key`** — Phase 0.5 Item 1. Blocks everything.
2. **Does `PREVIEW` create a `DRAFT` record?** The status enum includes `DRAFT`, so preview may persist. Verify with a GET before/after.
3. **Do time-window refund policies apply to club-initiated cancellations?** If `2HS_OR_LESS_IN_ADVANCE` applies when the *club* cancels, cancelling later costs more, and the 2h-vs-3h decision becomes financial as well as operational.
4. **Can outbound webhooks be created with this API key?** If yes, the polling architecture is unnecessary. This is the highest-leverage unknown after item 1.
5. **Does `POST /custom-emails` accept arbitrary recipient lists?** Would remove the need for a separate email provider.
6. **What does `/events/{eventId}/open-invitations/{id}/smses` send, and from what number?** Potentially an SMS path that doesn't touch the Twilio A2P campaign.
7. **`/templates/from-event/{eventId}`** — possibly a cleaner publish path than clone-then-patch.
8. **`GET /users/{userId}/preferences`** — does it carry communication opt-ins, including `smsMarketingOptIn`?
9. **Rate limits** — reported as ~300/min; no rate-limit headers documented in the spec. Confirm empirically.
10. **Small gaps in the §9 index** — a handful of paths in the POS, gotab, and replay-server ranges were truncated during capture. Re-query `docs-json` if one of those areas becomes relevant.

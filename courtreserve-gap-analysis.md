# CourtReserve vs PodPlay — Gap Analysis for Pulse Onboarding
**Date:** May 3, 2026  
**Scope:** What changes are required to support a CourtReserve club on Pulse, given the current PodPlay-first sync architecture.

---

## 1. Executive Summary

Pulse can be adapted to support CourtReserve clubs. The core retention logic (engagement states, milestones, streaks, AI recaps, win-back) is platform-agnostic and lives entirely in Supabase and the scheduler — it does not need to change. The work is concentrated in the **sync layer**: replacing the two PodPlay-specific modules (`importAllPlayers.js` and `syncEventAttendance.js`) with CourtReserve equivalents.

The biggest functional gap is **attendance attribution**. PodPlay provides a clean "who signed up for event X" endpoint per event. CourtReserve splits this across three different report endpoints, none of which exactly replicate PodPlay's model. This is solvable but requires a deliberate design choice on which CourtReserve signal to treat as "attended."

There are also meaningful **improvements** CourtReserve offers over PodPlay: richer member metadata, incremental member sync (delta queries), structured skill ratings, and membership lifecycle dates.

---

## 2. What Pulse Currently Pulls From PodPlay

### 2a. Member/Player Sync (`importAllPlayers.js`)
| PodPlay Field | Pulse DB Column | Notes |
|---|---|---|
| `user.id` | `players.external_id` | Primary link key |
| `user.firstName + lastName` | `players.name` | |
| `user.phoneNumber` | `players.phone` | Normalized to E.164 |
| `user.email` | `players.email` | |
| `user.membershipType` (GLOBAL_MEMBER / NONE) | `players.membership_status` | Mapped to "member" / "non-member" |

**Via separate ratings pass** (`GET /users/{id}/ratings`):
| PodPlay Field | Pulse DB Column |
|---|---|
| `item.doubles` or `item.singles` (where `item.type === "DUPR"`) | `players.dupr_rating` |
| `item.lastUpdated` | `players.dupr_updated_at` |

### 2b. Event Attendance Sync (`syncEventAttendance.js`)
**Step 1** — `GET /apis/v2/events?startTime=…&endTime=…&page=…&ipp=100`  
Fields used: `event.id`, `event.name`, `event.startTime`, `event.isCanceled`, `event.customType`, `event.type`, `event.tags[]`

**Step 2** — `GET /apis/v2/events/{id}/signups`  
Fields used: `signup.owner.id` (matched to `players.external_id`)

**What gets written to `attendances`:**
```
player_id, event_id, program_name, attended_at, program_type, level
```

---

## 3. CourtReserve API Coverage Map

### 3a. Member Data — ✅ COVERED (and richer)

**Endpoint:** `GET /api/v1/member/get`  
Auth role required: **Member / Read**

| CourtReserve Field | Maps to Pulse | Notes |
|---|---|---|
| `OrganizationMemberId` | `players.external_id` | Integer, must be stored as string |
| `FirstName + LastName` | `players.name` | |
| `PhoneNumber` | `players.phone` | Same E.164 normalization needed |
| `Email` | `players.email` | |
| `MembershipStatus` | `players.membership_status` | Richer: "Active", "Suspended", "Cancelled" |
| `Ratings[].Value` where `CategoryName` = club's pickleball rating | `players.dupr_rating` | See §4.1 |
| `MembershipStartDate` | (new column opportunity) | Useful for cohort analysis |
| `MembershipEndDate` | (new column opportunity) | Early-warning churn signal |
| `UserDefinedFields[]` | Not currently used | Custom club data, opt-in via `includeUserDefinedFields=true` |

**Pagination:** `pageSize` (max 100) + `pageNumber` — same model as PodPlay.

**Incremental sync (CourtReserve advantage):** `createdOrUpdatedFrom` / `createdOrUpdatedTo` params allow pulling only members changed in a window (max 31 days). PodPlay has no delta filter, so Pulse currently re-fetches all users every night. CourtReserve makes nightly incremental syncs cheaper.

---

### 3b. Event List — ✅ COVERED (equivalent)

**Endpoint:** `GET /api/v1/eventcalendar/eventlist`  
Auth role required: **EventCalendar / Read**

| CourtReserve Field | Maps to Pulse | Notes |
|---|---|---|
| `EventId` | `attendances.event_id` | |
| `EventName` | `attendances.program_name` | |
| `StartDateTime`, `EndDateTime` | `attended_at` (date part) | |
| `EventCategoryName` | `attendances.program_type` | Replaces `event.type` |
| `TagsInfo[].Name` | `attendances.level` | Same skill-level tag extraction logic applies |
| `IsCanceled` | filter (skip) | |
| `RatingRestrictions[]` | (bonus) | Min/max skill ratings per event — richer than PodPlay |

**No event description field.** CourtReserve does not expose a description on any event endpoint. **Decision: CourtReserve clubs use event name only** for agent program recommendations and the Programs page. Messages reference the program by name, level, day, and price — no free-text description. This is the accepted behaviour for all CourtReserve onboarding.

**Filter params:** `startDate`, `endDate`, `categoryId`, `tagIds`, `status` (Active/Canceled/All).  
**No server-side pagination** on this endpoint — it returns all events in the date window. For backfill, paginate by date range (monthly windows).

---

### 3c. Event Registrations — ⚠️ PARTIAL (no per-event lookup)

**Endpoint:** `GET /api/v1/eventregistrationreport/listactive`  
Auth role required: **EventRegistrationReport / Read**

This is the closest equivalent to PodPlay's `GET /events/{id}/signups`, but it works fundamentally differently:

| PodPlay model | CourtReserve model |
|---|---|
| Pull by **event ID** → get all signups for that event | Pull by **date range** → get all registrations across all events in window |
| Per-event request, O(n events) calls | One call per date-range window |
| Returns `signup.owner.id` | Returns `OrganizationMemberId` + `EventId` |

**CourtReserve registration fields:**
- `EventId`, `EventName`, `EventCategoryId`, `EventCategoryName`
- `EventDateId`, `StartTime`, `EndTime`
- `OrganizationMemberId`, `FirstName`, `LastName`, `Email`, `Phone`
- `SignedUpOnUtc`, `CancelledOnUtc`
- `Courts[]`, `PartnersInfo[]`, `UserDefinedFields[]`

**Design recommendation:** Pull by `eventDateFrom`/`eventDateTo` (sliding 31-day window) and fan out registrations to the correct events client-side. This eliminates the per-event API call loop that currently makes the PodPlay sync slow (300 ms delay between each event's signup fetch). A single date-range pull replaces hundreds of individual calls.

**31-day window constraint:** For the initial backfill from Jan 1, 2025, you'd need ~17 sequential calls. Not a problem in practice.

---

### 3d. Actual Attendance (Check-in) — ⚠️ SIGNAL MISMATCH (design decision needed)

CourtReserve distinguishes **registered** (signed up) from **attended** (physically checked in). Pulse currently treats PodPlay **signups** as attended. For CourtReserve you must choose:

**Option A — Use registrations as proxy for attendance (lowest friction)**  
Use `eventregistrationreport/listactive`. Filter out rows where `CancelledOnUtc` is set.  
- ✅ Has `OrganizationMemberId` — clean player matching  
- ✅ Has `EventId` — clean event linkage  
- ⚠️ Over-counts: includes no-shows (registered but didn't physically attend)  
- Consistent with PodPlay model (signups ≠ guaranteed attendance either)

**Option B — Use actual check-in data (most accurate)**  
Use `GET /api/v1/attendancereport/checkin`:
- `CheckinDateTime`, `EventName`, `ReservationStartDateTime`, `ReservationEndDateTime`
- `CheckInType`, `Type`
- ❌ **No `OrganizationMemberId`** — only name strings (`MemberFirstName`, `MemberLastName`, `MemberNumber`)
- Matching would require fuzzy name lookup — lossy and unreliable

Use `GET /api/v1/attendancereport/detailed` for door scan data:
- `OrganizationMemberId` ✅
- `DateTime` (check-in time) ✅
- ❌ **No `EventId`** — just physical facility entry, not tied to a specific event

Use `GET /api/v1/reservationreport/whoisheretoday`:
- `OrganizationMemberId` ✅, `EventName` ✅, `StartDateTime`/`EndDateTime` ✅
- ❌ No `EventId` — must join back to events by name+date
- ✅ Covers both court reservations and event registrations in one call

**Recommendation: Option A for initial launch.** Use `eventregistrationreport/listactive` as the attendance signal. This mirrors the PodPlay model exactly (signups = engagement proxy) and requires no member-name fuzzy matching. Clubs can be informed that "attended" means "registered and not cancelled." Revisit Option B if clubs request stricter check-in attribution.

---

### 3e. Per-Member Reservation History — ✅ AVAILABLE

**Endpoint:** `GET /api/v1/member/reservations`  
Params: `organizationMemberId` (required), `startDate`, `endDate`

Returns: `Id`, `TypeName`, `Start`, `End`, `IsEvent`, `EventName`, `Courts`, `PlayerNames`

This is equivalent to PodPlay's `GET /members/:id/activity`. Not currently used by Pulse's nightly chain (which is event-centric), but available if per-member backfill is ever needed.

---

### 3f. Skill Ratings — ✅ COVERED (different structure)

**Endpoints:**  
- `GET /api/v1/customrating/get` — list all custom rating categories  
- `GET /api/v1/member/get` with `includeRatings=true` — inline on member response

CourtReserve ratings are club-defined categories, not a single DUPR field. A PB club would typically have a "Pickleball Rating" or "DUPR" category. The sync would need to:
1. On first setup, call `GET /api/v1/customrating/get` and store the target `ratingCategoryId`
2. Pass `includeRatings=true` on the member fetch
3. Extract `Ratings[].Value` where `CategoryName` matches the configured category

This is more reliable than PodPlay's approach (which requires a separate per-member ratings API call with 404 handling).

---

### 3g. Membership Lifecycle — ✅ RICHER than PodPlay

CourtReserve exposes full membership lifecycle data not available from PodPlay:

| Data point | CourtReserve | PodPlay |
|---|---|---|
| Membership status (Active/Suspended/Cancelled) | `MembershipStatus` | "GLOBAL_MEMBER" / "NONE" |
| Membership start date | `MembershipStartDate` | ❌ not available |
| Membership end date | `MembershipEndDate` | ❌ not available |
| Membership type name | `MembershipTypeName` | ❌ not available |
| Suspend / reactivate / cancel via API | ✅ full CRUD | ❌ not available |

`MembershipEndDate` in particular is a high-value churn signal: Pulse could proactively flag members whose membership expires within 30 days and trigger a retention outreach before they lapse.

---

## 4. Gaps and Issues Requiring Resolution

### 4.1 — Skill Rating Category Configuration
**Gap:** PodPlay's DUPR is a known `type === "DUPR"` field. CourtReserve ratings are club-defined.  
**Resolution:** Introduce a `clubs.rating_category_name` or `clubs.cr_rating_category_id` config column. During onboarding, admin calls `GET /api/v1/customrating/get`, identifies the pickleball rating category, and stores its ID. The sync uses this ID to extract the correct value.

### 4.2 — API Key & Base URL per Club
**Gap:** Current code hardcodes `PODPLAY_BASE` and uses a single `PODPLAY_API_KEY` env var. CourtReserve clubs would have their own org-specific API key and potentially org-specific base URL (`/api/v1/` is shared but each key is scoped to one org).  
**Resolution:** Move platform credentials to the `clubs` table: `platform` (enum: "podplay" | "courtreserve"), `platform_api_key` (encrypted), `platform_org_id` (CourtReserve org integer ID). The sync layer reads these per club rather than from env vars. **This is the largest architectural change** — it's the prerequisite for Pulse becoming truly multi-club and multi-platform.

### 4.3 — No Per-Event Signup Lookup
**Gap:** `syncEventAttendance.js` iterates events and fetches signups per event (one call per event with 300 ms delay). CourtReserve has no equivalent endpoint.  
**Resolution:** Invert the sync strategy. Instead of iterating events → fetch signups, pull registrations by date range (one `eventregistrationreport/listactive` call per 31-day window) and fan out to event/player records in memory. **This is actually faster and simpler** — the current PodPlay approach makes hundreds of API calls per nightly run.

### 4.4 — 31-Day Query Window on All Report Endpoints
**Gap:** Every CourtReserve report endpoint caps at 31 days. PodPlay allows querying all-time with simple `page`/`ipp`.  
**Resolution:** Implement a sliding-window paginator for CourtReserve: iterate over 31-day chunks from the start date to today. For nightly incremental sync, a single 1-day or 7-day window suffices. For the initial backfill (Jan 1, 2025 → today = ~17 months), run ~18 sequential windows. This is a one-time cost.

### 4.5 — `external_id` Type Mismatch
**Gap:** `players.external_id` currently stores PodPlay user IDs (strings like "abc123"). CourtReserve `OrganizationMemberId` is an integer.  
**Resolution:** Store as `String(organizationMemberId)` — the DB column is already `text`, so no migration needed. Just ensure consistent serialization.

### 4.6 — Membership Status Mapping
**Gap:** PodPlay uses binary `GLOBAL_MEMBER` / `NONE`. CourtReserve uses `Active`, `Suspended`, `Cancelled` (and potentially others).  
**Resolution:** Expand `mapMembership()` function. Pulse's engagement engine only cares about "is this person a current member?" Suggested mapping:
- `"Active"` → `"member"`
- `"Suspended"` → `"member"` (still active, just payment-suspended)
- `"Cancelled"` → `"non-member"`
- anything else → `"non-member"`

### 4.7 — No Attendance-Level Flag on Registrations
**Gap:** `eventregistrationreport/listactive` returns registrations, not confirmed check-ins. A member who registered but didn't show would be counted as attended.  
**Resolution:** Cross-reference with `reservationreport/whoisheretoday` or `attendancereport/checkin` if the club enables door kiosk check-in. For clubs without kiosk setup, accept registrations as attendance proxy (same assumption Pulse makes with PodPlay signups).

### 4.8 — Auth Role Permissions Required
**Gap:** Different endpoints require different API roles. The CourtReserve API key must be provisioned with the correct roles.  
**Required roles for Pulse:**
| Role | Endpoints needed |
|---|---|
| Member / Read | `member/get`, `member/reservations`, `member/getssolink` |
| EventCalendar / Read | `eventcalendar/eventlist`, `eventcalendar/categories` |
| EventRegistrationReport / Read | `eventregistrationreport/listactive`, `listcancelled` |
| AttendanceReport / Read | `attendancereport/checkin`, `attendancereport/detailed` (optional) |
| ReservationReport / Read | `reservationreport/whoisheretoday` (optional) |
| CustomRating / Read | `customrating/get` (for initial setup) |
| MembershipType / Read | `membershiptype/get` (for initial setup) |

---

## 5. What Does NOT Need to Change

The following Pulse components are entirely platform-agnostic and require **zero changes**:

| Component | Why unchanged |
|---|---|
| `assembleProfile.js` | Reads from `players` + `attendances` tables — not platform-specific |
| `scheduler.ts` (Steps 2–7) | Engagement classification, streak detection, milestone checks, AI recaps — all run against Supabase data |
| All AI recap / agent logic | Consumes assembled profiles, not raw platform data |
| All dashboard API routes | Serve data from Supabase — source platform irrelevant |
| Supabase schema (players, attendances, clubs, conversations, messages) | No column changes required for basic CourtReserve support |
| Win-back attribution logic | Checks `attendances` table — platform-agnostic |
| Milestone detection | Counts rows in `attendances` — platform-agnostic |

---

## 6. New Opportunities CourtReserve Unlocks

Beyond parity with PodPlay, CourtReserve exposes data that enables **new Pulse features**:

| Opportunity | CourtReserve API | Potential Feature |
|---|---|---|
| Membership expiry alerts | `MembershipEndDate` | Proactive outreach 30/14/7 days before renewal — before they lapse |
| Membership suspension recovery | `MembershipStatus = Suspended` | Separate engagement segment: "paying but blocked" |
| Court reservation activity | `reservationreport/listactive` | Count non-event court time as engagement signal |
| Family accounts | `Family` API + `FamilyRole` on members | Household-level retention analytics |
| SSO deep-linking | `member/getssolink` | "View in CourtReserve" button on member cards in dashboard |
| Waitlist tracking | `eventregistrationreport/listwaitlist` | Identify high-demand members who can't get in — prioritize for outreach |
| Revenue signals | `transactions/list`, `revenuerecognition/list` | Correlate revenue with engagement to quantify retention ROI |

---

## 7. Implementation Roadmap

### Phase 1 — Minimum Viable CourtReserve Sync
*Estimated effort: 3–5 days*

1. Add `platform`, `platform_api_key`, `platform_org_id`, `cr_rating_category_id` columns to `clubs` table
2. Write `syncCourtReservePlayers.js` — replaces `importAllPlayers.js`:
   - `GET /api/v1/member/get` (paginated, `includeRatings=true`)
   - Map `OrganizationMemberId` → `external_id`, status, ratings
   - Use `createdOrUpdatedFrom/To` for incremental daily sync
3. Write `syncCourtReserveAttendance.js` — replaces `syncEventAttendance.js`:
   - `GET /api/v1/eventcalendar/eventlist` (31-day windows, tag extraction for `level`)
   - `GET /api/v1/eventregistrationreport/listactive` (31-day windows, fan-out to `attendances`)
   - Filter out cancelled registrations (`CancelledOnUtc` not null)
4. Update `scheduler.ts` Step 1 to dispatch to the correct sync module based on `clubs.platform`
5. Initial backfill script: iterate 31-day windows from Jan 1, 2025 → today

### Phase 2 — Enhanced Data
*Estimated effort: 2–3 days*

6. Sync `MembershipStartDate` / `MembershipEndDate` to new `players` columns
7. Add "membership expiring soon" engagement segment to scheduler
8. Add SSO link generation to the member detail API route

### Phase 3 — Stretch
*Estimated effort: as needed*

9. Court reservation activity as secondary engagement signal
10. Family/household grouping in the dashboard
11. Revenue correlation in AI recaps

---

## 8. Quick Reference — Endpoint Mapping

| Pulse sync step | PodPlay endpoint | CourtReserve equivalent |
|---|---|---|
| Fetch all members | `GET /apis/v2/users?page&ipp` | `GET /api/v1/member/get?pageNumber&pageSize` |
| Member delta (changed since T) | ❌ none | `GET /api/v1/member/get?createdOrUpdatedFrom&createdOrUpdatedTo` ✅ |
| Skill/DUPR rating | `GET /apis/v2/users/{id}/ratings` (separate pass) | `GET /api/v1/member/get?includeRatings=true` (inline) ✅ |
| Fetch event list | `GET /apis/v2/events?page&ipp` | `GET /api/v1/eventcalendar/eventlist?startDate&endDate` |
| Who attended event X | `GET /apis/v2/events/{id}/signups` | ❌ no direct equivalent — use date-range registration report |
| Attendance by date range | ❌ none | `GET /api/v1/eventregistrationreport/listactive?eventDateFrom&eventDateTo` ✅ |
| Physical check-in (optional) | ❌ none | `GET /api/v1/attendancereport/checkin` (name-only, no member ID) |
| Per-member activity | `GET /apis/v2/members/{id}/activity` | `GET /api/v1/member/reservations?organizationMemberId` |
| Membership lifecycle | ❌ none | `MembershipStartDate`, `MembershipEndDate` on member object ✅ |
| SSO deep link | ❌ none | `GET /api/v1/member/getssolink?orgMemberId` ✅ |

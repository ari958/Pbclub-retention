# Dashboard frontend inventory

Snapshot: **2026-09-30**, running workspace preview. This document reports existing source and observed behavior; it does not prescribe what to keep, remove, or change.

## Scope and evidence

- Dashboard source: `artifacts/dashboard/src`. Route definitions: `App.tsx`; navigation definitions: `components/Sidebar.tsx` and `lib/navMode.ts`.
- Runtime checks used the existing PB Club data and current configuration. No code, environment, workflow, approval, sending, or visibility settings were changed for this inventory.
- Browser navigation was protected by a guard allowing GET/HEAD/OPTIONS only. **No automatic non-safe request was attempted**, and no action, save, generation, import, approval, or send button was exercised. API write descriptions below are source findings, not successful write tests.
- The observed configuration was `VITE_NAV_MODE=retention`, `RETENTION_ONLY_MODE=true`, `DEFAULT_CLUB_SLUG=pb-club`, and `SMS_LIVE=false`. Approvals showed sending paused.
- Alternate navigation modes were inspected in source, not enabled. A parked page's legacy contents are described from source; its current runtime state is a redirect, not a tested rendering of those contents.
- Loading states are bounded observations, not diagnoses of permanent failure. Requests aborted by navigating away are distinguished from server errors.
- Source paths below refer to the current files. API paths are logical backend paths; `clubApiUrl` or the artifact API proxy can construct the browser-facing URL and append `slug`/`clubId`.

### Route notation

The dashboard's browser base is `/dashboard/`. In tables, **C** means `/dashboard/c/:slug`; the current club is `pb-club`. App's React routes omit the `/dashboard` basename. Bare-origin `/` and `/onboarding` are Express redirects to the default dashboard.

### Feature flags used in this inventory

- **APPROVALS**: dedicated retention review, explicit approval, pause/resume, or playbook interface.
- **DRAFTS/SEND**: message generation, draft editing, queueing, approval, or SMS dispatch.
- **PROFILES**: player attributes, assessment, attendance, confidence, DUPR, notes, or history.
- **BUDDIES**: buddy-pair/social-graph features.
- **LTP**: the `ltp_followup` retention playbook.

## Navigation: labels, routes, order, and visibility

Numbers are positions in the sidebar for that mode; `—` means no sidebar entry. Settings is appended after each mode's entries.

| Sidebar label | React route | `retention` | `pulse` | `programming` | `all` | Effect of `RETENTION_ONLY_MODE=true` versus `false` on this item's visibility |
|---|---|---:|---:|---:|---:|---|
| Dashboard | `/c/:slug/dashboard` | 1 | 1 | — | 1 | None; visibility is controlled by `VITE_NAV_MODE`. |
| Approvals | `/c/:slug/approvals` | 2 | — | — | — | None; the route remains defined even without its nav entry. |
| Players | `/c/:slug/players` | 3 | 2 | — | 2 | None. |
| Progress | `/c/:slug/assessments` | — | 3 | — | 3 | None. |
| Session Ratings | `/c/:slug/feedback` | — | 4 | — | 4 | None; automated feedback is separately parked on the server. |
| Messages | `/c/:slug/messages` | 4 | 5 | — | 5 | None. |
| Programming | `/c/:slug/programming` | — | 6 | — | 6 | None; this page's catalog API is not the `/api/programming/*` family. |
| Programs | `/c/:slug/programs` | — | — | 1 | 7 | None; its programming API dependencies return 423 when retention-only mode is on. |
| Rules | `/c/:slug/rules` | — | — | 2 | 8 | None; the current page is a local placeholder. |
| Settings | `/c/:slug/settings` | 5 | 7 | 3 | 9 | None; some Settings cards use the frontend retention-mode condition. |

**Exact sequences**

- `retention`: Dashboard → Approvals → Players → Messages → Settings.
- `pulse`: Dashboard → Players → Progress → Session Ratings → Messages → Programming → Settings.
- `programming`: Programs → Rules → Settings.
- `all`: Dashboard → Players → Progress → Session Ratings → Messages → Programming → Programs → Rules → Settings.

Additional navigation facts:

- Supported source type values are `retention`, `programming`, `pulse`, and `all`. An absent `VITE_NAV_MODE` defaults to `retention`. The source casts, rather than validates, other strings; an unmatched string selects no mode-specific list and leaves Settings.
- The sidebar **ClubSwitcher** appears only when `VITE_NAV_MODE !== "retention"`. It reads `GET /api/clubs`; selecting a club replaces the slug in the current route, preserving the subpath and search string, or navigates to `/c/<newSlug>` if outside a club route. It has no dependency on the backend retention-only flag.
- No sidebar entry exists for onboarding, experiments as a standalone page, Archive, or the mockup sandbox.
- Messages has a count/reply-alert indicator, not an additional route. The bottom sync indicator is status text, not a page link.
- **Frontend parking and backend parking are independent.** `Parked` in `App.tsx` checks `VITE_NAV_MODE === "retention"`. The server checks `RETENTION_ONLY_MODE !== "false"`. Thus a legacy page can be shown in another navigation mode while its API still returns 423.
- Progress remains a directly accessible route in the current retention navigation mode despite having no sidebar entry. Approvals remains directly accessible in all four modes despite being listed only in retention navigation.

## Pages and routes

API sets in this table are expanded, method by method, in the API register below. **COMMON** applies to mounted club pages: direct Supabase `clubs` lookup by slug, plus Sidebar's club-filtered unread `messages` count joined to `players`. COMMON also contains a conditional, automatic direct `messages.read_at` update on the Messages route, described below. **PD** and **BULK** run only when their embedded drawer/modal is opened. A redirected legacy route performs the club lookup and then loads Approvals; it does not mount its legacy page.

| Page / source file | Route | One-line purpose | Feature area; major sections, tabs, cards, modals | APIs / direct Supabase access | Parked dependencies | Current state |
|---|---|---|---|---|---|---|
| Dashboard — `artifacts/dashboard/src/pages/Dashboard.tsx` | `C/dashboard` | Overview of engagement, outreach queue, and player introductions. | **DRAFTS/SEND, PROFILES, BUDDIES**. Recommendations carousel; Active Players / High Churn Risk / Outreach Queue stats; Needs Attention; Club Health; Outreach Queue with inline editor; New Player Intros; PlayerDrawer; confirmation dialog. | COMMON + DASH + PD. Direct reads: `players`, `messages`, joined `players`/`conversations`. These Dashboard queries explicitly filter active club ID. Local recommendation dismissals use localStorage. | DASH endpoints are not blocked by the retention-only flag. Legacy controls still exist; sending has approval/policy checks rather than a blanket parked response. | Core renders normally. Observed 171 active, 1,266 high churn risk, and queue 0. Introductions remained **“Loading upcoming sessions…”** during the visit; its GET was later aborted on navigation. |
| Approvals — `artifacts/dashboard/src/pages/Approvals.tsx` | `C/approvals` | Review retention facts and draft text, then explicitly approve or skip selected messages. | **APPROVALS, DRAFTS/SEND, PROFILES, LTP**. Mode/safety banners; Pause/Resume; Generate drafts; operator label; All / Drafted / Approved / Skipped / Sent filters; playbook groups; ApprovalCards; bulk-review modal; resume confirmation. | COMMON + APPROVAL. No page-local direct Supabase access; server resolves playbooks, candidates, players, messages, and club mode. | Retention endpoints are active. Missing schema has its own error handling, not retention parking. | Renders an **empty**, schema-ready list: all counters 0, **“No drafts.”** Sending paused; live sending off. Initial **“kill switch unverifiable, sends blocked”** was transient before the mode response settled. |
| Players — `artifacts/dashboard/src/pages/Players.tsx` | `C/players` | Search, filter, sort, export, and inspect the player roster. | **PROFILES, DRAFTS/SEND, BUDDIES via drawer**. Search; Status / Progress / Member filters; roster table, pagination; CSV export; Send Bulk Outreach; PlayerDrawer; BulkMessageModal. | COMMON + PD + BULK. Direct reads: `players`, `session_feedback` for level-concern classification. Those two page-local reads have **no club predicate**. CSV export is local. | None of its own reads or profile endpoints are blanket parked. Bulk/manual sends remain subject to send approval/policy checks. | Renders normally and populated: observed 2,820 players, 50 rows on page 1 of 57. Opened drawer rendered; Court Crew was still **“Loading…”** during observation. |
| Progress / Assessments — `artifacts/dashboard/src/pages/Assessments.tsx` | `C/assessments` | Triage players needing progression assessment and show recent assessments. | **PROFILES**. Needs Assessment; progression action buttons; Recently Assessed, latest 20. No modal or separate page tabs. | COMMON + ASSESS. Direct reads: two `players` queries for null/non-null progression; **no club predicate** in those queries. | Progression endpoint is active. Lack of a retention sidebar link does not park the route. | Renders and populates after loading: observed 2,817 needing assessment. Initial 0/Loading and **“No assessments yet”** changed after settling. One console HTTP 500 had no identifiable resource URL in the audit; it is not attributed to a particular endpoint. |
| Messages — `artifacts/dashboard/src/pages/Messages.tsx` | `C/messages` | Browse message history, directions, delivery/status details, and linked player profiles. | **DRAFTS/SEND history, PROFILES**. All / Outbound / Replies / Failed tabs; Player / Message / Direction / Status / Link / Date table; PlayerDrawer. | COMMON + PD on row selection. Page-local read: latest 200 `messages`, with `conversations` and `players` embeds; **no club predicate**. No page-local HTTP write endpoint, but Sidebar conditionally updates `messages.read_at` directly. | Message history reads are active. Drawer actions are not blanket parked. | **Partially loaded during the audit:** **“0 shown”** and a **“Loading…”** row; a settled message list was not captured. Console duplicate-key warnings were observed; exact non-identifier text is recorded below. No page-level error message was displayed. |
| Settings — `artifacts/dashboard/src/pages/Settings.tsx` | `C/settings` | Club schedule/status and message-template management, with additional legacy cards in other modes. | **DRAFTS/SEND templates**. Club; Sync Schedule; Sync & Import Log; Message Templates with inline list/editor. Source also defines Agent Configuration and Monthly Recap & Milestones, hidden when frontend `RETENTION` is true. No Settings tabs/modal. | COMMON + SETTINGS + RECAP when its card is mounted. Direct read: `clubs.agent_config, scheduled_sync_time` by club ID, with an agent-config-only fallback. No direct Supabase write. | `/api/recap/*` returns 423 in server retention-only mode. Templates and schedule endpoints are not parked. | **Partially broken:** **“Failed to load templates.”** Templates GET returned 500: **`column message_templates.club_id does not exist`**. UI also displayed **“No templates yet.”** Sync/import log was loading; schedule displayed 02:00, America/New_York. |
| Session Ratings / SessionFeedback — `artifacts/dashboard/src/pages/SessionFeedback.tsx` | `C/feedback` | Summarize recent self/peer session-fit responses and edit the rating-message template. | **PROFILES / level feedback; messaging template**. Last-30-days session list; level filter; session-health summaries; Rating Message Template editor. | Source: COMMON + FEEDBACK; direct `session_feedback` reads without club filter. Current redirect loads APPROVAL instead. | Frontend `Parked` redirect in retention navigation. Its template GET/PATCH are active; automated post-session feedback is separately parked server-side. | **Not mounted:** current URL redirects to `C/approvals`. |
| Programming — `artifacts/dashboard/src/pages/Programming.tsx` | `C/programming` | Program catalog with historical fill-rate/archetype analysis. | Program analytics. All time / 90d / 30d / 7d filters; summary cards; confidence legend; expandable archetypes and raw-name variants. | Source: COMMON + CATALOG. No page-local direct Supabase reads/writes. | Frontend `Parked` redirect. `GET /api/programs/catalog` itself is **not** covered by `/api/programming/*` parking. | **Not mounted:** redirects to `C/approvals`. |
| Programs — `artifacts/dashboard/src/pages/Programs.tsx` | `C/programs` | Upcoming program risks, promotion queue/decisions, experiments, and archives. | **DRAFTS/SEND, PROFILES, BUDDIES signals in promotion/experiment data**. Upcoming / Queue / Log / Experiments / Archive tabs. Upcoming risk/evaluator; promotion candidate detail/funnel/ranked list/audience approval; decision log/pagination; embedded experiment views; archived decisions/experiments. Detail/veto views are inline, not additional routes. | Source: COMMON + PROGRAMS + EXPERIMENTS + ARCHIVED. No page-local direct Supabase reads/writes. | Frontend redirect. All PROGRAMS `/api/programming/*` dependencies return 423 with server flag on. Experiment dispatch/mark-sent also return 423; other experiment endpoints are not blanket parked. | **Not mounted:** redirects to `C/approvals`. |
| ExperimentsTab — `artifacts/dashboard/src/pages/ExperimentsTab.tsx` | No independent route; Programs → Experiments | Configure and inspect promotion experiments, participants, delivery actions, and measurement. | **DRAFTS/SEND, PROFILES, BUDDIES eligibility signals**. List / Setup / Detail / Pooled Results internal views; upcoming session selection; split/notes/pool preview; participant message editor; veto panel; copy/mark-sent/dry-run/dispatch; measurement/results. | EXPERIMENTS. No direct browser Supabase access in this module. | Parent Programs redirects now. Send and mark-sent are specifically 423 parked; read/setup/edit/veto/measure endpoints are not. | **Not mounted** through current parent route; source is referenced, not dead/unimported. |
| ArchivedExperiments — `artifacts/dashboard/src/pages/ArchivedExperiments.tsx` | No independent route; Programs → Archive | Display experiments associated with past events. | **DRAFTS/SEND history**. Polling archived-experiment table and result/status rows. | ARCHIVED. No direct browser Supabase access in this module. | Parent Programs redirects; experiment list endpoint itself is not parked. | **Not mounted** through current parent route; referenced by Programs. |
| Rules — `artifacts/dashboard/src/pages/Rules.tsx` | `C/rules` | Placeholder surface for programming-rule configuration. | Programming rules. **“No rules configured yet”**; explanatory cancellation-threshold, offset, and override text. No working rule editor/API action. | COMMON only; no page-local API or Supabase operation. | Frontend redirect; no own dependency to receive a parked API response. | **Not mounted:** redirects to `C/approvals`. The placeholder text is source content, not its current rendered state. |
| Standalone experiments route — `artifacts/dashboard/src/App.tsx` | `C/experiments` | Route alias redirecting to Approvals. | **APPROVALS** destination. It does not mount `ExperimentsTab`. | Destination COMMON + APPROVAL. | Wrapped in `Parked`, but even outside retention navigation its child is a redirect to `../approvals`. | Redirects to `C/approvals` in **every** navigation mode. |
| Onboarding source — `artifacts/dashboard/src/pages/Onboarding.tsx`; redirect in `App.tsx` | `/dashboard/onboarding`; bare `/onboarding` | Preserved three-step club/platform/import wizard; current route is a dashboard redirect. | Source: club basics → platform connection → review/launch/import progress. API-key field is a source feature; no credential values are included here. | Source: ONBOARD. No current wizard mount/calls. Redirect destination uses COMMON + DASH. | `/api/onboarding/*` returns 404 when server retention-only mode is on. Frontend route redirects in **all** navigation modes. | Redirects to `/dashboard/c/pb-club/dashboard`; wizard is not mounted. |
| Default/root redirects — `artifacts/dashboard/src/App.tsx`; `artifacts/api-server/src/app.ts` | Bare `/`; `/dashboard/`; `C` index | Open the default club dashboard or the explicit club's dashboard. | Dashboard destination. | No redirect-local data call; destination COMMON + DASH. | None. Stored `clubs.onboarded` does not gate access. | All tested PB/default roots reached `/dashboard/c/pb-club/dashboard`. |
| Club gate — `artifacts/dashboard/src/App.tsx`, `artifacts/dashboard/src/lib/ClubContext.tsx` | Wrapper for `C/*` | Resolve a club before rendering its page. | Loading club / Club not found / Error loading club states; otherwise child outlet. | Direct Supabase `clubs` lookup by explicit slug or default slug. | None; bad explicit slug does not fall back to PB Club. | PB Club resolves normally. The other gate states are source-defined, not observed failures for PB Club. |
| Actual wildcard 404 — inline `NotFound` in `artifacts/dashboard/src/App.tsx` | `/dashboard/*` unmatched | Display the actual application's unknown-route page. | Plain 404 text; no product shell or modal. | None. | None. | Tested `/dashboard/unknown-route`: **“404 — Page not found.”** |
| Unreferenced 404 source — `artifacts/dashboard/src/pages/not-found.tsx` | No route/import from App | Standalone scaffold Card-style 404, distinct from the active wildcard. | Card with **“404 Page Not Found”** source text. | None. | Not parking; this file is not the routed 404. | **Not reachable as a page.** |

## Shared components with embedded features

### PlayerDrawer

File: `artifacts/dashboard/src/components/PlayerDrawer.tsx`. Hosts: Dashboard, Players, Messages. **There are no drawer tabs**: sections are vertically stacked.

| Section / control | Feature | Reads / writes / behavior |
|---|---|---|
| Header; engagement-state indicator; close; Escape/backdrop close | **PROFILES** | Displays selected player. Closing is local UI state. |
| **Run Agent** header button | **DRAFTS/SEND, PROFILES** | `POST /api/agent/run`; generates legacy outreach/conversation/message data. This endpoint has no retention-only blanket guard. |
| Profile: last visit, phone, skill, membership | **PROFILES** | Direct `players` read by player ID; fallback query omits churn fields on missing-column error. |
| Progression selector: Ready to Advance / Developing / At Ceiling / Unset | **PROFILES / progression** | `POST /api/players/:id/progression`. |
| Coach Level choice buttons; conditional Clear | **PROFILES / coach level** | Direct `level_taxonomy` read filtered to active club; `PATCH /api/players/:id/coach-level`. |
| Coach notes input | **PROFILES / coach level** | `PATCH /api/players/:id/coach-level-notes` **on blur**. |
| DUPR Rating numeric input | **PROFILES / DUPR** | `PATCH /api/players/:id` **on blur**; subsequently reloads confidence. This is a manual rating edit, not a drawer-triggered bulk import. |
| Level Confidence scores | **PROFILES / level confidence** | `GET /api/players/:id/confidence`; no section-local write action. |
| Court Crew: up to five buddies, 3+ shared sessions | **BUDDIES, PROFILES** | `GET /api/social-graph/player/:id/buddies`; server uses buddy-pair/player data. No buddy-edit button. |
| Notes | **PROFILES** | `PATCH /api/players/:id/notes` **on blur**. |
| Conditional Churn Risk section | **PROFILES / retention-risk model** | Displays loaded risk/score for high/medium risk. No independent mutation control. |
| Generated Message, conditional after agent result or opt-out result | **DRAFTS/SEND** | Edit → Save/Cancel changes local result/editor state. This **Save is not a message-draft persistence API call**. Dismiss is local. |
| **Send** in Generated Message | **DRAFTS/SEND / manual dispatch** | Reads the newest matching conversation/message from Supabase, then `POST /api/messages/send` with the stored message ID. It does not send the local `resultDraft` directly. Shared approval/send policies still apply. |
| Attendance, latest 15 | **PROFILES** | Direct `attendances` read by player ID. |
| Conversations and nested message history, skipped marker | **PROFILES, DRAFTS/SEND history** | Direct `conversations` with nested `messages`, by player ID. |

Drawer endpoint set **PD**:

- Reads: `GET /api/players/:id/confidence`; `GET /api/social-graph/player/:id/buddies`.
- Writes: `POST /api/players/:id/progression`; `PATCH /api/players/:id/notes`; `PATCH /api/players/:id/coach-level`; `PATCH /api/players/:id/coach-level-notes`; `PATCH /api/players/:id`; `POST /api/agent/run`; `POST /api/messages/send`.
- Direct browser Supabase reads: `players`, `attendances`, `conversations`, nested `messages`, `level_taxonomy`, plus conversation/message lookups for Send. No direct Supabase write in this component.
- Opening the drawer performs reads. Editing a notes/coach-notes/DUPR field and then blurring it is a write; the inventory did not exercise those controls.
- It does **not** call the retention candidate/playbook approval endpoints. Its legacy agent/send controls are distinct from ApprovalCard.

### BulkMessageModal

File: `artifacts/dashboard/src/components/BulkMessageModal.tsx`. Host: Players. Flags: **DRAFTS/SEND, PROFILES**.

- Template/custom-message mode; template picker; personalized variable chips/custom body editor.
- Event picker and manual event details. Variables include first name, skill level, club name, last visit, event date, booking link, event link, and next level.
- Opt-in-only checkbox/filter; recipient, preview, cost summaries.
- Confirmation view with typed operator label, personalized previews, Go back / Confirm send, close/cancel. The UI identifies the operator label as attribution rather than authenticated sign-in.
- **BULK reads:** `GET /api/templates`, `GET /api/events/upcoming`. The templates fallback directly reads `message_templates` without a club predicate if the fetch promise rejects; an HTTP error response is not itself a network rejection.
- **BULK write:** `POST /api/messages/bulk` with player IDs, message/template information, and `approved_by`. This is not `/api/retention/playbooks/:key/approve`.
- Modal opening performs reads; confirmation is an explicit send/approval action. This action was not tested.

### ApprovalCard and Approvals dialogs

Files: `components/ApprovalCard.tsx`, `pages/Approvals.tsx`, `lib/approvalGuards.ts`, `lib/retentionApi.ts`. Host: Approvals. Flags: **APPROVALS, DRAFTS/SEND, PROFILES, LTP**.

- Card: status/selection checkbox; stored draft text; first Learn-to-Play event/date; existing booking or suggested next program; classmates count; promo/coupon validation warning; approval/scheduling/sent timestamps.
- Actions: Edit, Save, Cancel, Approve, Skip. Saving an edit revokes approval/scheduling; approving uses the exact reviewed body snapshot.
- Group controls: select/clear reviewed drafts; Review bulk approval. Open edits prevent that group's bulk approval.
- Bulk modal: explicit selected candidates and reviewed snapshots, review text, operator attribution, approval confirmation/error reporting.
- Resume confirmation: already-approved scheduled messages may send after resume; resume does not approve new messages.
- Mode banners: schema readiness, live versus simulation, test override configured, known/unknown kill switch, paused state.
- Status filters exist for All / Drafted / Approved / Skipped / Sent. The current list API fetches only **drafted/approved** candidates; these UI filters do not create an independent history request.
- No direct browser Supabase operation. All operations use **APPROVAL**, expanded below.
- `ltp_followup` is a server-selected enabled playbook, not a separate frontend route. The migration seeds promo `LTPNEXT25`, offer text `25% off your next program`, next-program names `Beginner 60&60 Clinic`, `30 & 30 Beginner Drills & Guided Play`, and `Path to Advanced Beginner`, with holdout 0. These are seed values, not a separately verified current configuration-table dump.
- Classmates count in retention context is a same-Learn-to-Play attendance/signup fact, not a frontend `buddy_pairs` edit.

### Sidebar, ClubProvider, ClubSwitcher, Toast, and page-local helpers

| Component / source | Embedded feature | Data/actions |
|---|---|---|
| `components/Sidebar.tsx` | Navigation; message badge/unread reply alert; sync indicator | Direct unread `messages` HEAD/count query with `players!player_id!inner(club_id)` filtered to active club ID; polls every 30 seconds. On the Messages route with unread count >0, a 1.5-second timer directly updates inbound/unread `messages.read_at`; this update has **no club predicate**. Mode-specific navigation is listed above. |
| `lib/ClubContext.tsx` | Club lookup and URL scope | Reads `clubs(id, slug, name, timezone)` by slug. `useClub`/`clubApiUrl` supply context/URLs; they do not automatically add filters to every independently written Supabase query. |
| `components/ClubSwitcher.tsx` | Multi-club dropdown, currently not rendered | `GET /api/clubs`; local route navigation on selection; preserves current subpath/search. No data write. |
| `components/Toast.tsx` | Shared notification provider | App-wide success/error notifications; no endpoint/table. |
| Dashboard-local `RecTile`, confirmation dialog, progress/status/panel helpers | Recommendations, **DRAFTS/SEND** confirmation/display, engagement status | Use Dashboard's data/actions. No additional endpoint independent of DASH. |
| Players-local churn/state/progression badges, filter chips, sortable headers, skeleton rows | **PROFILES** roster display/filtering | Use Players' loaded data/local state; no independent mutation. |
| Settings-local sync log, recap/milestone panel, template editor | Job status, legacy messaging, templates | Use SETTINGS/RECAP; conditional visibility described in the page table. |
| Programs-local upcoming, queue, decision log, promotion detail | Promotion/risk/decision tools; **DRAFTS/SEND, PROFILES, BUDDIES signals** | Use PROGRAMS. Audience approval is a decision PATCH. The detail's copy/selection and dispatch-related explanatory UI do not add a separate Programs dispatch call. Actual experiment dispatch belongs to ExperimentsTab. |

## API and direct-data register

This register expands the page-table API sets. Lists include conditional controls and embedded features, not just calls made on initial load.

### COMMON — club-page shell

- Direct Supabase read: `clubs`, filtered by slug (`ClubContext`).
- Direct Supabase read: `messages`, inbound/unread count, joined to `players` and filtered by club (`Sidebar`).
- Conditional non-retention switcher read: `GET /api/clubs`.
- No shell HTTP write endpoint. Sidebar does contain a conditional **direct Supabase write**: on the Messages route with unread count >0, it updates `messages.read_at` for inbound rows whose `read_at` is null, after 1.5 seconds. Unlike the count query, the update has **no club predicate**. This condition did not result in a non-safe request during the guarded browser audit; it is nevertheless an existing automatic write path.

### DASH — Dashboard

Reads:

1. `GET /api/players/winback-stats`.
2. `GET /api/sync/events/status` initially and during status polling.
3. `GET /api/social-graph/staff-intro-cards`.
4. Direct Supabase: club-filtered `players` roster/churn, `messages` pending-agent-outbound queue and sent/inbound counts, joined `players`/`conversations`.

Writes:

1. `POST /api/agent/run` individually or in the batch outreach loop.
2. `POST /api/sync/events`.
3. `POST /api/messages/send`.
4. `POST /api/messages/skip`.
5. `PATCH /api/messages/:messageId/draft`.

Local state/storage: recommendation dismissal, queue editor/confirmation, and `pulse_dismissed_recs` localStorage. These are not application-database writes.

The event-status GET contains existing server-side stale-job reclamation (`routes/sync.ts`); GET classification describes the frontend method, not a guarantee that every server read handler has zero bookkeeping side effects.

### APPROVAL — dedicated retention page/cards

Read:

- `GET /api/retention/approvals` immediately, periodically while visible, and on visibility return.

Writes:

1. `POST /api/retention/generate`.
2. `PATCH /api/retention/candidates/:id`.
3. `POST /api/retention/candidates/:id/approve`.
4. `POST /api/retention/candidates/:id/skip`.
5. `POST /api/retention/playbooks/:key/approve`.
6. `PATCH /api/retention/kill-switch`.

These are active with the server retention-only flag on. Generation creates unapproved/unscheduled drafts; approval schedules messages for a permitted send window rather than performing direct Twilio transport.

**Server-side, not direct frontend Supabase:** the list resolves `clubs`, `retention_playbooks`, `retention_candidates`, `players`, and `messages`; generation reads attendance/player/playbook/context data and calls `retention_create_draft`; review mutations call `retention_update_candidate`; kill-switch mutation updates `clubs.sms_kill_switch`. Dispatch bookkeeping uses `messages` and `contact_ledger`. Live coupon/signup/event checks use PodPlay server-side. The frontend has no `retention_playbooks` editor endpoint.

### ASSESS — Progress

- Direct Supabase reads: `players` with null progression; `players` with non-null progression ordered for the recent-20 list. Neither page-local query filters club ID.
- Write: `POST /api/players/:id/progression`, including the displayed progression choice and operator assessment label.
- No other page-local endpoint; COMMON still applies.

### SETTINGS — currently rendered Settings operations

Reads:

1. `GET /api/sync/events/status`.
2. `GET /api/import/status`.
3. `GET /api/templates`.
4. Direct Supabase: `clubs.agent_config, scheduled_sync_time`, by club ID; missing-schedule-column fallback reads `clubs.agent_config`.

Writes:

1. `PATCH /api/clubs/:clubId/settings` — `scheduled_sync_time` and `timezone`.
2. `POST /api/templates` — create.
3. `PATCH /api/templates/:id` — update.

Template UI: built-in read-only/custom-editable selection; variable chips; tags; text editor and preview. Agent Configuration is a **read-only key/value display**, with no edit/save controls; it still loads its data while the display is hidden in retention navigation mode. Sync Schedule has a source-defined missing-schema SQL instruction state; that state was not the visible templates error during this audit.

### RECAP — Settings' conditional legacy card

Reads:

- `GET /api/recap/monthly/status`.
- `GET /api/recap/milestones/status`.

Writes/action requests:

- `POST /api/recap/monthly/test` — per-player dry-run preview.
- `POST /api/recap/monthly` — run batch.
- `POST /api/recap/milestones` — run check.

The card contains monthly/milestone job states, Run now / Run check now, and an expandable per-player preview. The entire card is unmounted when frontend `RETENTION` is true. All listed endpoints return 423 when backend retention-only mode is on.

### FEEDBACK — Session Ratings source

- Direct Supabase read: `session_feedback(event_id, level, self_fit, others_fit, responded_at)`, last 30 days and responded rows; no club predicate.
- Read: `GET /api/templates`, selecting the tagged rating-message template.
- Write: `PATCH /api/templates/:id`.
- Built-in templates are displayed as read-only. This page does not itself call the feedback-send/test endpoints.

### CATALOG — Programming catalog source

- Read: `GET /api/programs/catalog`, with slug and optional `days` filter.
- No page-local write endpoint or direct Supabase access.
- This endpoint is implemented in `routes/programs.ts`, not the parked `routes/programming.ts` prefix.

### PROGRAMS — Programs source

Reads:

1. `GET /api/programming/upcoming-risk?clubId=…`.
2. `GET /api/programming/decisions?clubId=…&scope=current|archived&limit=…&offset=…`.
3. `GET /api/programming/promotion-candidates/:decisionId?clubId=…&rebuild=false`.
4. `GET /api/programming/queue?clubId=…`.

Writes:

1. `POST /api/programming/evaluate`.
2. `PATCH /api/programming/decisions/:decisionId/approve?clubId=…` — promotion audience approval.

All return 423 with backend retention-only mode on. Page source has no additional direct Supabase operation or separate promotion-detail dispatch endpoint. Candidate selection/copy controls are local UI/clipboard operations. Embedded experiment calls are listed next.

### EXPERIMENTS — embedded ExperimentsTab source

Reads:

1. `GET /api/experiments`.
2. `GET /api/experiments/eligible-sessions`.
3. `GET /api/experiments/:id`.
4. `GET /api/experiments/pooled-results`.
5. `GET /api/experiments/:id/measure/status`, followed by detail refresh.

Writes/action requests:

1. `POST /api/experiments/preview`.
2. `POST /api/experiments`.
3. `PATCH /api/experiments/:id/participants/:pid` — stored participant-message edit.
4. `POST /api/experiments/:id/veto/:pid`.
5. `POST /api/experiments/:id/mark-sent`.
6. `POST /api/experiments/:id/measure`.
7. `POST /api/experiments/:id/send` — both dry-run and actual-dispatch request variants.

Only mark-sent and send have the retention-only guards in this route family. Other listed operations remain server-defined/active, although the current frontend parent is redirected. No direct browser Supabase access in ExperimentsTab.

### ARCHIVED — embedded ArchivedExperiments source

- Read/poll: `GET /api/experiments?clubId=…`, filtered/displayed for past-event experiments.
- No own write endpoint or direct browser Supabase access.

### ONBOARD — preserved, unmounted wizard source

1. **“Let's set up your club”**: club name, timezone, nightly sync time; Continue.
2. **“Connect your platform”**: PodPlay/CourtReserve cards, API-key field, CourtReserve organization ID, Test connection, optional skill-rating category, Back/Continue.
3. **“Review & launch”**: settings summary, Launch import, Back, import stats/log/error/progress, Go to dashboard.

Source calls:

- `POST /api/onboarding/validate`.
- `POST /api/onboarding/complete`.
- `POST /api/import/players`.
- `GET /api/import/status` polling.
- Preserved, unmounted `OnboardingGuard` calls `GET /api/onboarding/status`.

No current frontend route mounts the wizard or guard. Onboarding endpoints return 404 with retention-only mode on; import endpoints are not included in the onboarding prefix guard.

## Retention-mode dependency behavior and actual errors

| Endpoint / behavior | Current server flag on | Exact text / distinction |
|---|---|---|
| `/api/onboarding/*` | 404 | JSON error **`Not found`**. GET status was checked; POST route guarding was inspected in source rather than exercised during this read-only inventory. |
| `/api/programming/*` | 423, reads and writes | **`Programming tools are parked by RETENTION_ONLY_MODE`**. GET queue was checked. |
| `/api/recap/*` | 423, reads and writes | **`Legacy recap and milestone tools are parked by RETENTION_ONLY_MODE`**. GET monthly status was checked. |
| `POST /api/experiments/:id/mark-sent` | 423 | **`Experiment dispatch bookkeeping is parked by RETENTION_ONLY_MODE`**; source guard, not action-tested. |
| `POST /api/experiments/:id/send` | 423, including dry run | **`Experiment dispatch is parked by RETENTION_ONLY_MODE`**; source guard, not action-tested. |
| Other listed experiment operations | Not blanket parked | Parent page redirects in the current navigation mode; these server handlers do not share a global experiment-prefix guard. |
| `/api/programs/catalog` | Not blanket parked | Separate `programs` router. Current frontend route is nevertheless redirected. |
| `/api/agent/run` | Not blanket parked | Legacy draft-generation endpoint remains defined; no action was invoked. |
| Profile, template, messages, sync/import, social-graph, retention endpoints listed above | Not blanket parked by this flag | Individual validation, approval, consent/opt-out, policy, schema, and transport checks are separate from parking. |
| Settings `GET /api/templates?slug=pb-club` | Actual 500, unrelated to parking | Response: **`{"error":"column message_templates.club_id does not exist"}`**. Visible: **“Failed to load templates.”** |

Additional runtime observations:

- Messages console warning, with the record-specific key omitted: **“Encountered two children with the same key … Non-unique keys may cause children to be duplicated and/or omitted …”**. This was a React warning, not a shown HTTP error or proven page crash.
- Assessments had a console **“Failed to load resource: the server responded with a status of 500”** without a captured resource URL. The later view populated; no cause is assigned here.
- During navigation, the staff-intro GET and an unread-count Supabase HEAD ended **`net::ERR_ABORTED`**. The read-only method guard did not block them.
- Approvals' simulated/paused warnings are intentional mode text, not evidence of live delivery: **“Live sending is off. Approved texts are consumed by the queue as simulated sends and will not be delivered”** and **“Paused: nothing sends, including approved messages.”**
- Source-defined missing-retention-schema UI says **“Retention tables are unavailable (schema not ready). Approvals cannot be loaded or changed until the database is migrated.”** That error was **not** the current state: the live Approvals response was schema-ready.

## Retention touchpoint cross-reference

| Touchpoint | Existing frontend surfaces | Connection |
|---|---|---|
| Approvals | Approvals, ApprovalCard, bulk-review/resume dialogs; legacy-route redirects | Dedicated retention endpoint family; exact-body per-message review and scheduling. |
| Message drafts | Approvals; Dashboard queue/inline editor; PlayerDrawer generated message; BulkMessageModal; ExperimentsTab participant editor | Retention candidates, legacy agent queue, bulk sending, and experiment messages are distinct UI/data paths. |
| Sending | Approvals approval/pause controls; Dashboard Send; PlayerDrawer Send; BulkMessageModal Confirm send; ExperimentsTab send/mark-sent | Approvals schedules rather than directly transporting. Legacy manual/bulk send controls still exist. Experiment dispatch is backend parked. |
| Buddy pairs | PlayerDrawer Court Crew; Dashboard New Player Intros; promotion/experiment scoring context | Browser uses social-graph APIs; server resolves `buddy_pairs`/players. No frontend buddy-pair editor found. |
| Player profiles | Players, PlayerDrawer, Assessments, Dashboard Needs Attention, Messages drawer, Session Ratings | Profile reads, coach level, progression, DUPR, notes, confidence, attendance/conversation history, and session-fit data. |
| `ltp_followup` | Approvals grouping/context; Generate drafts | Server `retentionEngine.ts` selects this enabled playbook. No standalone page, nav item, or playbook configuration editor. |

## Other frontend app: mockup sandbox

- The other registered service, **API Server** (`artifacts/api-server`), is a backend API artifact used by the dashboard, not an additional frontend application or sidebar destination.
- Directory: **`artifacts/mockup-sandbox`**. Registered artifact title **Canvas**, kind **design**.
- It is a separate Vite **Component Preview Server** for canvas/UI prototypes, not the dashboard and not an additional player/retention app.
- Actual preview base: **`/__mockup`**. Component preview URLs are **`/__mockup/preview/<ComponentName>`**. `mockupPreviewPlugin.ts` discovers `src/components/mockups/*.tsx` and generates the module registry.
- At inspection, `src/.generated/mockup-components.ts` had an **empty module registry**, and no concrete custom mockup component/variant source was found. This is a source finding, not a claim that the workspace canvas has no other shapes.
- Current `GET /__mockup` rendered the normal **“Component Preview Server”** landing page. The different URL `/mockup-sandbox/` returned **404, “Cannot GET /mockup-sandbox/”**; it is not the registered preview base.
- Artifact TOML has a development service only: `pnpm --filter @workspace/mockup-sandbox run dev`, port 8081, paths/base `/__mockup`; no production service configuration is present there.
- Deployment metadata returned `success=true`, **`isDeployed=false`**, and no production URL. There is no active published project deployment, including this sandbox, at the time of the inventory.
- Dashboard navigation/source has no sandbox link, iframe, import, or handoff route. It is directly reachable through its workspace preview path and registered Canvas artifact, **not through dashboard navigation**.

## Defined but unlinked, parked, or source-unreferenced code

These categories are distinct; a missing sidebar link does not itself make a component dead.

| Item | Definition / relationship | Actual reachability |
|---|---|---|
| Assessments / Progress | App route `C/assessments` | No retention sidebar link, but directly loadable now; present in pulse/all nav. |
| Approvals outside retention nav | App route `C/approvals` | No pulse/programming/all sidebar entry, but direct route remains mounted. |
| Dashboard/Players/Messages in programming nav | App routes | No programming-mode sidebar entry; direct routes still exist. |
| SessionFeedback, Programming, Programs, Rules | App-imported page modules wrapped in `Parked` | Redirected in current retention navigation. Their mode-specific links and source implementations remain defined. |
| ExperimentsTab | Imported/rendered by Programs → Experiments | No standalone nav/route; currently inaccessible through the parked parent, not source-unreferenced. |
| ArchivedExperiments | Imported/rendered by Programs → Archive | Same parent limitation; not source-unreferenced. |
| `C/experiments` route | Redirect element in App | Defined but never mounts the experiment component; destination is Approvals even outside retention navigation. |
| Onboarding page module | `pages/Onboarding.tsx` | Not imported into the active App route graph; preserved source. `/onboarding` redirects instead. |
| OnboardingGuard | Function in `App.tsx` | Defined but not mounted. Its onboarding-status fetch does not run. |
| ClubSwitcher | Sidebar conditional | Defined/referenced; not rendered in retention navigation; available in other nav modes. |
| Settings Agent Configuration and Monthly Recap & Milestones | Conditional cards in Settings | Not rendered when frontend `RETENTION` is true; definitions remain. Agent-config data still loads. |
| `pages/not-found.tsx` | Scaffold 404 component | Not imported/routed by App; App's inline NotFound handles actual unmatched URLs. |
| App wildcard / club error gate | App-local components | Not sidebar-linked; reachable by unmatched/bad-club URLs or lookup errors. Not unreferenced. |

The six top-level product/shared component modules are `ApprovalCard.tsx`, `BulkMessageModal.tsx`, `ClubSwitcher.tsx`, `PlayerDrawer.tsx`, `Sidebar.tsx`, and `Toast.tsx`. All have parent references; conditional/current-mode reachability is described above.

### Generic UI scaffold

`artifacts/dashboard/src/components/ui/` contains framework primitives, not independent product pages or navigation entries:

`accordion`, `alert-dialog`, `alert`, `aspect-ratio`, `avatar`, `badge`, `breadcrumb`, `button-group`, `button`, `calendar`, `card`, `carousel`, `chart`, `checkbox`, `collapsible`, `command`, `context-menu`, `dialog`, `drawer`, `dropdown-menu`, `empty`, `field`, `form`, `hover-card`, `input-group`, `input-otp`, `input`, `item`, `kbd`, `label`, `menubar`, `navigation-menu`, `pagination`, `popover`, `progress`, `radio-group`, `resizable`, `scroll-area`, `select`, `separator`, `sheet`, `sidebar`, `skeleton`, `slider`, `sonner`, `spinner`, `switch`, `table`, `tabs`, `textarea`, `toaster`, `toast`, `toggle-group`, `toggle`, `tooltip` (all `.tsx`).

Many are referenced only by other scaffold modules or not by product pages. `ui/card.tsx` is referenced by the unrouted `pages/not-found.tsx`. `ui/sidebar.tsx` is distinct from the active product `components/Sidebar.tsx`. This file list does **not** assert that every primitive is unreferenced; no independent product route is defined for any of them.

## Principal source references

- Routing/gates: `artifacts/dashboard/src/App.tsx`; default lookup/API URL helper: `src/lib/ClubContext.tsx`; modes: `src/lib/navMode.ts`; navigation/unread query: `src/components/Sidebar.tsx`.
- Page modules and embedded components: full paths in the page table; shared components under `artifacts/dashboard/src/components`.
- Retention requests/state: `artifacts/dashboard/src/lib/retentionApi.ts`, `approvalGuards.ts`, `pages/Approvals.tsx`, `components/ApprovalCard.tsx`.
- Server guards/contracts: `artifacts/api-server/src/routes/{onboarding,programming,recap,experiments,retention,agent,messages,players,socialGraph,templates,sync,import,programs,events,clubs}.ts`; `src/lib/retentionPolicy.ts`.
- Playbook/context: `artifacts/api-server/src/lib/{retentionEngine,retentionContext,retentionCoupons,retentionText}.ts`; seed/schema: `artifacts/api-server/migrations/010_retention_approvals.sql`.
- Separate preview app: `artifacts/mockup-sandbox/.replit-artifact/artifact.toml`, `src/App.tsx`, `mockupPreviewPlugin.ts`, and `src/.generated/mockup-components.ts`.
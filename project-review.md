# Pulse / PB Club — Full Project Review

## Project Purpose

A pickleball club retention dashboard ("Pulse") for PB Club operators. It connects to the PodPlay SaaS platform (via REST API) and a Supabase PostgreSQL database. Operators can view player engagement states, run an AI retention agent (Claude Sonnet) to generate personalized SMS outreach, manage a message queue, bulk-message filtered player segments using templates, and assess player progression levels.

---

## Stack

- **Monorepo**: pnpm workspaces
- **Backend**: Express 5 (TypeScript, ESM, built with esbuild), port from `PORT` env var
- **Frontend**: React 19 + Vite (TypeScript, CSS custom properties — NO Tailwind in use on dashboard despite being in package.json)
- **Database**: Supabase (PostgreSQL), accessed via `@supabase/supabase-js`
- **SMS**: Twilio (with optional Messaging Service SID for URL shortening / click tracking)
- **AI**: Anthropic Claude (`claude-sonnet-4-6`) via `@anthropic-ai/sdk`
- **External API**: PodPlay (`https://pbclub.podplay.app/apis/v2`), auth: `x-api-key` header
- **Routing**: Shared reverse proxy, dashboard at `/dashboard/`, API at `/api/`

---

## Environment Variables

| Variable | Used By | Purpose |
|---|---|---|
| `PORT` | api-server | Server listen port (required) |
| `SUPABASE_URL` | api-server | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | api-server | Full-access key (templates seed, templates CRUD) |
| `SUPABASE_ANON_KEY` | api-server | Row-level-security key (most routes) |
| `PODPLAY_API_KEY` | api-server | PodPlay REST API authentication |
| `ANTHROPIC_API_KEY` | api-server | Claude agent |
| `TWILIO_ACCOUNT_SID` | api-server | Twilio SMS account |
| `TWILIO_AUTH_TOKEN` | api-server | Twilio SMS auth |
| `TWILIO_PHONE_NUMBER` | api-server | Sender number (fallback if no Messaging Service) |
| `TWILIO_MESSAGING_SERVICE_SID` | api-server | Optional — enables URL shortening + click tracking |
| `PUBLIC_API_URL` | api-server | Optional — Twilio status callback base URL |
| `SESSION_SECRET` | (present, unused in visible code) | — |
| `VITE_SUPABASE_URL` | dashboard | Supabase URL (client-side) |
| `VITE_SUPABASE_ANON_KEY` | dashboard | Supabase anon key (client-side) |

---

## Database Tables (inferred from queries)

- **players** — `id, external_id, name, skill_level, membership_status, progression_status, last_visit_date, phone, notes, club_id, sms_opt_in, last_synced_at`
- **clubs** — `id, name, agent_config, scheduled_sync_time, timezone`
- **attendances** — `id, player_id, event_id, program_name, program_type, attended_at` — unique constraint on `(player_id, program_name, attended_at)`
- **conversations** — `id, player_id, club_id, triggered_by`
- **messages** — `id, conversation_id, body, direction, sent_by, signup_url, twilio_message_sid, link_clicked, link_clicked_at`
- **message_templates** — `id, name, body, use_case_tags, is_builtin, created_at, updated_at`

---

## API Routes

### Health
- `GET /api/healthz` — liveness probe

### Players
- `GET /api/players/:id/profile` — assembles player profile + attendance from Supabase

### Agent
- `POST /api/agent/run` — rate-limited (20/min); assembles player profile + available programs, calls Claude, creates conversation + message records, returns generated SMS
  - Rate limit: 20 req/min per IP via `express-rate-limit`

### Sync
- `POST /api/sync/all` — kicks off background event-centric attendance sync for all stale players (>6h since last sync); cancellable
- `POST /api/sync/player` — syncs a single player
- `GET /api/sync/status` — polls background sync job
- `POST /api/sync/cancel` — cancels running sync

### Programs
- Serves available programs (inferred from usage in agent route)

### Messages
- `POST /api/messages/send` — sends a single queued message via Twilio; stores `twilio_message_sid`
- `POST /api/messages/webhook/status` — Twilio delivery/click webhook; updates `link_clicked` + `link_clicked_at`
- `POST /api/messages/bulk` — sends bulk SMS to filtered player list; interpolates `{{first_name}}`, `{{skill_level}}`, `{{last_visit}}`, `{{club_name}}`; creates conversation + message records; 100ms inter-message delay

### Templates
- `GET /api/templates` — lists all templates (built-ins first)
- `POST /api/templates` — creates custom template
- `PATCH /api/templates/:id` — updates custom template (blocks editing built-ins)

### Events
- `GET /api/events/upcoming` — returns top 20 PUBLISHED future events from PodPlay, excluding INTERNAL/OPERATIONS/PRIVATE/PRIVATE_EVENT subtypes; 5-minute in-memory cache; `signupUrl` is `https://pbclub.podplay.app/community/events/{id}` for every event

### Import
- `POST /api/import/players` — full player import from PodPlay; cancellable background job
- `GET /api/import/status` — polls import job
- `POST /api/import/cancel` — cancels import
- `POST /api/import/phone-numbers` — imports phone numbers for players that have `external_id` but no phone; cancellable
- `GET /api/import/phone-numbers/status`
- `POST /api/import/phone-numbers/cancel`

### Admin
- `POST /api/admin/dedupe-attendances` — deduplication job for attendance table
- `GET /api/admin/dedupe-attendances/status`

---

## Frontend Pages

### Dashboard (`/`)
- Stat cards: total players, active, lapsing, dormant, never-visited (clickable → filters at-risk panel), plus a Response Rate stub
- **At-Risk Panel** — filterable player table with sortable columns, inline progression dropdown, "Run Agent" per-row button
- **Needs Assessment Panel** — players with `progression_status = null`; one-click assessment buttons (Ready / Developing / Ceiling)
- **Message Queue Panel** — unsent agent-generated messages; Send / Skip / Edit inline; player name links to drawer
- Batch Agent run + Sync All with confirmation dialogs
- Player drawer integration
- `supabase.from("players").select(...).limit(2000)` — fetches everything client-side

### Players (`/players`)
- Full player table with search + 4 filters (engagement state, progression, membership, name search)
- Sortable columns: Name, State, Progression, Skill Level, Last Visit, Membership
- Pagination (50/page)
- Export CSV (all filtered results)
- "Send bulk message (N)" button → opens BulkMessageModal with current filter set
- Player drawer on row click

### Assessments (`/assessments`)
- All players where `progression_status IS NULL`, ordered by last visit desc
- One-click assessment (Ready to Advance / Developing / At Ceiling)
- Shows name, skill level, last visit, notes
- Removes row from list after 600ms animation

### Messages (`/messages`)
- Flat table of all messages joined to conversations + players
- Columns: Player, Message (truncated to 100 chars), Direction badge, Status badge, Link clicked, Date
- Player name → PlayerDrawer

### Settings (`/settings`)
- Club name display
- Sync schedule (time + timezone), writes to `clubs` table; graceful fallback if columns don't exist
- Agent Configuration (read-only display of `clubs.agent_config`)
- **Message Templates** — split-pane: list left, editor right; built-ins viewable but not editable; custom templates create/edit; variable insertion via click; tag management (use_case_tags)

---

## Key Components

### BulkMessageModal
The most complex component. Flow:
1. Mode toggle: "Use a template" | "Write custom"
2. Template selector (if template mode) — shows name, built-in/custom badge, tags
3. **Event picker** — only renders if selected template body contains `{{event_date}}`, `{{event_link}}`, or `{{booking_link}}`
   - Loads events from `/api/events/upcoming` on mount
   - Native `<select>` with formatted options: `{Type} · {Name} · {Weekday, Mon D, HH:MM AM} · {skill range}`
   - On selection: auto-fills `event_date`, `event_link`, `booking_link` in `operatorVals`
   - `manualLinkNeeded` flag for events without a signup URL (now unused since all events have URLs)
4. Non-event operator vars (e.g. `{{next_level}}`) — amber-bordered inputs
5. Custom textarea with var-insert chips (custom mode only)
6. Live preview with color-coded variable resolution:
   - Resolved player vars → green highlight
   - Filled operator vars → green highlight
   - Unfilled operator vars → amber highlight
7. SMS opt-in toggle
8. Footer: estimated cost, cancel/send buttons
- `canSend` guard: body not empty + template selected (if template mode) + all operator vars filled + event picker satisfied + eligible recipients > 0

### PlayerDrawer
- Slide-in from right (200ms CSS transition)
- Loads player profile, last 15 attendances, conversations (with messages)
- Inline notes (auto-save on blur)
- Progression dropdown (writes directly to Supabase)
- Run Agent → shows generated message inline → Edit / Send / Cancel
- Escape key closes

### Sidebar
- Fixed left nav (220px)
- Active route highlighted with amber left border
- Badge support (for pending counts)
- Live sync status indicator

---

## AI Agent System Prompt (summary)

The Claude agent receives:
- Player profile: name, skill_level, last_visit_date, programs_attended, membership_status, progression_status, notes
- Available programs: name, description, program_type, price, price_member, skill_level, tags, spots_remaining, start_time (pre-formatted ET date string)

Rules:
- Compute engagement state (active ≤14d / lapsing 15–30d / dormant 31+d)
- Route by `progression_status`: ready-to-advance → next level; developing → current level; at-ceiling → lateral/community; null → lateral default
- 1–3 sentences max, casual-professional tone, no exclamation points, no filler phrases
- Must include full date alongside day name (uses `start_time` field as-is)
- Returns JSON: `{ engagement_state, progression_routing, recommended_programs, message, reasoning }`

---

## Data Flow: Bulk Message Send

1. Operator filters players on `/players` page
2. Clicks "Send bulk message (N)" → BulkMessageModal opens with `recipients = displayed` (all filtered, not just current page)
3. Selects template or writes custom message
4. If template has event vars → selects event → `event_date`, `event_link`, `booking_link` auto-filled
5. Operator fills any remaining vars (e.g. `{{next_level}}`)
6. Clicks Send → `POST /api/messages/bulk` with `{ player_ids, message_body, template_id }`
7. Server filters to `sms_opt_in = true` players with phones
8. For each eligible player:
   - Interpolates `{{first_name}}`, `{{skill_level}}`, `{{last_visit}}`, `{{club_name}}`
   - Creates conversation record (`triggered_by: "bulk"`)
   - Sends via Twilio (if configured), stores `twilio_message_sid`
   - Inserts message record
   - Waits 100ms

Note: operator-resolved vars (`event_date`, `event_link`, etc.) are baked into `message_body` before the API call — the server only interpolates the per-player dynamic vars. This is the correct split.

---

## Data Flow: Event Sync

Two parallel sync strategies exist:
1. **Player-centric** (`syncPlayerAttendance.js`): For each player with `external_id`, fetches all their past events from PodPlay `/events?userId=...`, upserts attendance records
2. **Event-centric** (`syncEventAttendance.js`): Paginates all past events from `SYNC_START_DATE` to now, for each event fetches `/signups`, matches `signup.owner.id` → player via Map lookup, upserts attendance. This is the preferred/canonical approach (used in `/api/sync/all`)

Both use `onConflict: "player_id,program_name,attended_at"` upsert for idempotency.

---

## Known Issues / Observations

1. **Mixed Supabase client instantiation**: Some routes create `createClient` at module level (capturing env vars at import time), others instantiate per-request. Some use `SUPABASE_SERVICE_ROLE_KEY`, others use `SUPABASE_ANON_KEY`. This is inconsistent — `messages.ts` uses anon key for a route that writes conversations, which may hit RLS issues in some setups.

2. **`console.log` in server code**: The sync and import JS files use `console.log` extensively instead of the pino logger. The project has a `logger` singleton and `req.log` pattern — these files predate that and haven't been migrated.

3. **In-memory cache for events**: The 5-minute cache (`let cache`) is module-level, resets on server restart. Fine for current scale; not suitable for multi-process deployment.

4. **Background jobs are in-memory**: Import, sync, dedupe job state is module-level. Multiple server restarts or future horizontal scaling would lose job state.

5. **No authentication**: The dashboard and API have no auth layer. Any request to `/api/*` is unauthenticated.

6. **`assembleProfile.js` uses anon key**: Direct Supabase queries without the service role key — depends on RLS policies being permissive for the agent's reads.

7. **Bulk send interpolation gap**: The bulk endpoint interpolates player vars server-side but does NOT interpolate event vars or operator-fill vars — those must be pre-resolved by the frontend before the API call. This works correctly given the current frontend design, but is not documented in the API contract.

8. **`message_body` in bulk send contains raw operator vars if unfilled**: The server's `interpolate()` function only handles `first_name`, `skill_level`, `last_visit`, `club_name`. If the frontend sends a body that still has `{{event_date}}` etc. unresolved (which it shouldn't given `canSend` guard), those tokens appear literally in the SMS.

9. **`SUPABASE_SERVICE_ROLE_KEY ?? SUPABASE_ANON_KEY` fallback**: Templates route falls back to anon key if service role key is absent. The seed at startup does the same. Built-in template protection (preventing edits) works via application logic, not DB-level permissions.

10. **`fetchAvailablePrograms` has no caching**: Called on every agent run. For batch agent runs over many players this means one PodPlay API call per player. Should be cached similarly to events.

11. **JS files mixed with TS**: `assembleProfile.js`, `fetchAvailablePrograms.js`, `syncEventAttendance.js`, `syncPlayerAttendance.js`, `importAllPlayers.js`, `importPhoneNumbers.js`, `dedupeAttendances.js` are plain JavaScript with `// @ts-ignore` imports. They bypass TypeScript checking entirely.

12. **`Dashboard.tsx` fetches all players client-side**: `supabase.from("players").select(...).limit(2000)` — all filtering, sorting, and pagination is in-memory. Fine for current scale; will become slow with larger datasets.

13. **`Players.tsx` also fetches all players**: Same pattern. The two pages independently fetch the full player list with no shared cache.

14. **`manualLinkNeeded` in BulkMessageModal is now always false**: Since `signupUrl` is now statically constructed for every event, `ev.signupUrl` is always truthy, so the manual link input is dead code (but harmless).

15. **`event_link` variable in BulkMessageModal**: `ALL_VARS` array (for the custom mode insert chips) doesn't include `{{event_link}}`, only `{{booking_link}}`. Both are set to the same URL value. The two are equivalent in the current implementation.

16. **Twilio status callback only handles clicks**: The webhook route checks for `MessageStatus === "clicked"` or `event === "link_click"`. Standard Twilio delivery statuses (`delivered`, `failed`, `undelivered`) are received but ignored — no delivery status is written back to the messages table.

17. **`claude-sonnet-4-6` model string**: This is a non-standard model identifier. Standard Anthropic model IDs use `claude-3-5-sonnet-20241022` or similar. May be a typo or internal alias — should be verified.

18. **Rate limit on `/api/agent/run` only**: Only the agent endpoint has rate limiting. Import, sync, and bulk send endpoints have no rate limiting.

---

## File Structure

```
artifacts/
├── api-server/src/
│   ├── index.ts                    — server entry, startup seed
│   ├── app.ts                      — express setup, middleware
│   ├── lib/logger.ts               — pino singleton
│   ├── routes/
│   │   ├── index.ts                — router composition
│   │   ├── health.ts               — GET /api/healthz
│   │   ├── players.ts              — GET /api/players/:id/profile
│   │   ├── agent.ts                — POST /api/agent/run (Claude)
│   │   ├── events.ts               — GET /api/events/upcoming
│   │   ├── messages.ts             — send, bulk, webhook
│   │   ├── templates.ts            — CRUD for message_templates
│   │   ├── sync.ts                 — attendance sync jobs
│   │   ├── import.ts               — player + phone import jobs
│   │   ├── programs.ts             — available programs
│   │   └── admin.ts                — dedupe job
│   ├── assembleProfile.js          — player profile query (JS)
│   ├── fetchAvailablePrograms.js   — PodPlay events → agent format (JS)
│   ├── syncEventAttendance.js      — event-centric sync (JS)
│   ├── syncPlayerAttendance.js     — player-centric sync (JS)
│   ├── importAllPlayers.js         — full player import (JS)
│   ├── importPhoneNumbers.js       — phone number import (JS)
│   └── dedupeAttendances.js        — attendance deduplication (JS)
│
└── dashboard/src/
    ├── App.tsx                     — router setup
    ├── main.tsx                    — entry point
    ├── index.css                   — CSS custom properties, global styles
    ├── lib/
    │   ├── types.ts                — Player, MessageQueueItem, MessageTemplate
    │   ├── supabase.ts             — client singleton
    │   ├── helpers.ts              — engagement state, date utils, color maps
    │   └── utils.ts                — (cn utility, likely unused by dashboard)
    ├── components/
    │   ├── Sidebar.tsx             — nav + sync status
    │   ├── PlayerDrawer.tsx        — slide-in player detail + agent run
    │   ├── BulkMessageModal.tsx    — bulk SMS composer
    │   └── Toast.tsx               — toast notification system
    └── pages/
        ├── Dashboard.tsx           — main retention view
        ├── Players.tsx             — full player table + bulk messaging
        ├── Assessments.tsx         — progression assessment queue
        ├── Messages.tsx            — message history log
        └── Settings.tsx            — club config + template manager
```

---

## CSS Design System

No utility framework — pure CSS custom properties:

```css
--bg-surface: #ffffff
--bg-surface-2: #f6f8fa
--border: #e1e4e8
--text-primary: #0f1117
--text-secondary: #57606a
--text-tertiary: #8b949e
--accent: #E8A838          /* amber */
--state-active: #2ea043    /* green */
--state-lapsing: #d4813a   /* orange */
--state-dormant: #cf222e   /* red */
--font-sans: 'DM Sans'
--font-mono: 'DM Mono'
```

All layout uses inline styles with CSS variable references. No component library on the dashboard (the `ui/` folder appears to be a shadcn installation that is not used by the dashboard pages).

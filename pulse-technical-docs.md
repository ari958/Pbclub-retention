# Pulse / PB Club — Technical Developer Documentation

> Updated: 2026-05-18 (FIX 1–3: DB-first API key pattern, PB Club backfill, multi-tenant rule)  
> Stack: React + TypeScript + Vite (dashboard) · Express 5 + Supabase (API server) · pnpm monorepo  
> Supabase project ref: `knblhxfwvebxntoshiqm`  
> Club ID (PB Club): `c8976e15-e002-4619-bb4b-b1a70f5cd7ab` — no longer hardcoded in routes; resolved via `requireClub` middleware from `?clubId=` or `?slug=` query param

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Repository Structure](#2-repository-structure)
3. [Environment Variables & Secrets](#3-environment-variables--secrets)
4. [Database Schema](#4-database-schema)
5. [External Integrations](#5-external-integrations)
6. [Backend Systems — Library Layer](#6-backend-systems--library-layer)
   - 6.1 Supabase Client
   - 6.2 Job Store
   - 6.3 Scheduler
   - 6.4 Churn Score Engine
   - 6.5 Level Confidence Engine
   - 6.6 Post-Session Feedback Engine
   - 6.7 Monthly Recap Engine
   - 6.8 Milestone Check Engine
   - 6.9 Skill Level Extractor
   - 6.10 Twilio Client
7. [API Reference](#7-api-reference)
   - 7.1 Health
   - 7.2 Players
   - 7.3 Agent
   - 7.4 Sync
   - 7.5 Messages
   - 7.6 Feedback
   - 7.7 Social Graph
   - 7.8 Templates
   - 7.9 Recap & Milestones
   - 7.10 Import & Admin
   - 7.11 Programs & Events
8. [Frontend Pages & Components](#8-frontend-pages--components)
   - 8.1 Dashboard
   - 8.2 Players
   - 8.3 Settings
   - 8.4 Messages
   - 8.5 Feedback
   - 8.6 PlayerDrawer
9. [Nightly Chain — Step by Step](#9-nightly-chain--step-by-step)
10. [Data Sync Pipeline](#10-data-sync-pipeline)
11. [SMS & TCPA Compliance](#11-sms--tcpa-compliance)
12. [Ops Procedures](#12-ops-procedures)
13. [Known Issues & Sharp Edges](#13-known-issues--sharp-edges)
14. [Onboarding Checklist](#14-onboarding-checklist)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (React + Vite)                                             │
│  /dashboard/*   →  artifacts/dashboard                             │
│  Talks to API via relative fetch("/api/...")                        │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │ reverse proxy (path /api)
┌─────────────────────────────────▼───────────────────────────────────┐
│  Express 5 API Server                                               │
│  artifacts/api-server                                               │
│  Port: $PORT  (default 8080)                                        │
│  Mounts all routes at /api                                          │
│  Uses pino logger  (req.log / logger singleton)                     │
└──────────────┬──────────────────────────────────────┬──────────────┘
               │                                      │
┌──────────────▼───────────┐          ┌───────────────▼──────────────┐
│  Supabase (PostgreSQL)   │          │  External Services            │
│  knblhxfwvebxntoshiqm    │          │  · PodPlay REST API (v2)      │
│  Tables: see §4          │          │  · Anthropic (Claude)         │
│  RLS enabled on all      │          │  · Twilio SMS                 │
│  tables                  │          └──────────────────────────────┘
└──────────────────────────┘
```

The **reverse proxy** (`artifact.toml`) routes:
- `/` → dashboard Vite dev server  
- `/api` → Express API server  

Services must not hard-code port numbers; they read `$PORT`.

### Architectural Rule: Multi-Tenant by Default

Every route handler, library function, and worker that calls an external API **must resolve credentials from the database first**. The env-var `PODPLAY_API_KEY` may only appear as a last-resort fallback (`?? process.env.PODPLAY_API_KEY`), never as the sole source of truth.

**Pattern (route handlers):**
```ts
const { data: club } = await supabase.from("clubs")
  .select("platform_api_key, platform_subdomain").eq("id", clubId).maybeSingle();
const apiKey = club.platform_api_key ?? process.env.PODPLAY_API_KEY;
if (!club.platform_api_key) req.log.warn({ clubId }, "env-var fallback for API key");
```

**Pattern (lib functions — private helpers accept `apiKey` as param):**
```ts
async function resolveCredentials(clubId: string | undefined, log): Promise<{ podplayBase: string; apiKey: string }> {
  const { data } = await supabase.from("clubs")
    .select("platform_api_key, platform_subdomain").eq("id", clubId).maybeSingle();
  const apiKey = data?.platform_api_key ?? process.env.PODPLAY_API_KEY ?? "";
  if (!data?.platform_api_key) log.warn({ clubId }, "env-var fallback — backfill clubs.platform_api_key");
  return { podplayBase: `https://${data.platform_subdomain}.podplay.app`, apiKey };
}
```

**Why:** the env-var is a global singleton; reading it as the primary source silently serves the wrong club's API key in any multi-club context.

**Backfill checklist (when onboarding a new club):**  
1. Insert club row with correct `platform_subdomain`, `platform_api_key`, `platform_org_id`.  
2. Run `SELECT slug, platform_api_key IS NOT NULL AS has_key FROM clubs;` to confirm.  
3. No code changes needed — the DB-first pattern picks up the key automatically.

---

## 2. Repository Structure

```
workspace/
├── artifacts/
│   ├── api-server/           Express 5 API
│   │   ├── src/
│   │   │   ├── app.ts        Express app factory
│   │   │   ├── server.ts     Entry point, starts scheduler
│   │   │   ├── routes/       Route modules (one file per domain)
│   │   │   ├── lib/          Pure-TypeScript business logic
│   │   │   ├── assembleProfile.js      Player profile builder (JS)
│   │   │   ├── fetchAvailablePrograms.js   PodPlay program fetch (JS)
│   │   │   ├── importAllPlayers.js     Bulk player import (JS)
│   │   │   ├── syncPlayerAttendance.js Per-player attendance sync (JS)
│   │   │   └── syncEventAttendance.js  Event-centric attendance sync (JS)
│   │   └── package.json
│   └── dashboard/            React + Vite SPA
│       ├── src/
│       │   ├── pages/        Route-level page components
│       │   ├── components/   Shared UI components
│       │   ├── lib/          supabase client, helpers, types
│       │   └── main.tsx      App entry, React Router setup
│       └── package.json
├── lib/                      Shared workspace libraries (if any)
├── scripts/                  Utility scripts
├── pnpm-workspace.yaml
└── replit.md
```

### Key conventions

- **No `console.log` in server code.** Use `req.log` inside route handlers; use the `logger` singleton everywhere else.
- Route files declare paths **without** the `/api` prefix (Express mounts the router at `/api`).
- TypeScript-compiled `.js` helpers are imported with `// @ts-ignore` from route/lib files since they live as plain CommonJS modules.

---

## 3. Environment Variables & Secrets

All secrets are managed as Replit environment secrets. **Never** hard-code values.

| Variable | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL` | api-server, dashboard | Supabase project URL |
| `SUPABASE_ANON_KEY` | dashboard | Supabase anon/public key (browser client) |
| `SUPABASE_SERVICE_ROLE_KEY` | api-server | Supabase service-role key (bypasses RLS) |
| `ANTHROPIC_API_KEY` | api-server | Claude API (agent, recap, milestones) |
| `PODPLAY_API_KEY` | api-server | PodPlay REST API authentication |
| `SESSION_SECRET` | api-server | Express session signing |
| `PORT` | api-server, dashboard | Injected by Replit; do not hard-code |

### Supabase clients

**api-server** uses the **service-role key** — it bypasses Row Level Security. This is intentional so the server can read and write all rows freely.

**dashboard** uses the **anon key** — subject to RLS policies. All direct Supabase queries from the browser go through RLS.

---

## 4. Database Schema

All tables live in the Supabase project. RLS is enabled; the API server bypasses it via the service-role key.

### `clubs`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | `c8976e15-e002-4619-bb4b-b1a70f5cd7ab` |
| name | text | Club display name |
| agent_config | jsonb | Agent tuning parameters |
| scheduled_sync_time | time | "HH:MM" for nightly chain |
| timezone | text | IANA tz string (default "America/New_York") |

### `players`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | Internal ID |
| external_id | text | PodPlay member ID |
| name | text | Full name |
| phone | text | E.164 or local format |
| skill_level | text | Self-reported or system-inferred |
| membership_status | text | "member" or null/other |
| progression_status | text | "ready-to-advance" \| "developing" \| "at-ceiling" \| null |
| progression_previous | text | Prior progression status before last update |
| progression_assessed_at | timestamptz | |
| progression_assessed_by | text | "operator" or staff name |
| last_visit_date | date | Date of most recent attendance (no time) |
| last_outbound_at | timestamptz | Cooldown anchor for SMS |
| last_synced_at | timestamptz | When PodPlay sync last ran for this player |
| notes | text | Coach/staff freeform observations |
| club_id | uuid FK → clubs | |
| sms_opt_in | boolean | Default true; false = never send |
| coach_assigned_level | text | Coach override level |
| coach_level_notes | text | |
| coach_level_set_by | text | |
| coach_level_set_at | timestamptz | Used by monthly recap for "level changed this month" |
| dupr_rating | numeric(4,2) | 1.0–6.0 |
| dupr_updated_at | timestamptz | |
| churn_score | integer | 0–100 composite score |
| churn_risk | text | "high" \| "medium" \| "low" |

### `attendances`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| player_id | uuid FK → players | |
| event_id | text | PodPlay event ID |
| program_name | text | |
| attended_at | date | Date of session |
| level | text | Skill level of the session (used for confidence) |
| club_id | uuid FK → clubs | |

### `conversations`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| player_id | uuid FK → players | |
| club_id | uuid FK → clubs | |
| triggered_by | text | "active" \| "lapsing" \| "dormant" \| "bulk" \| "inbound" \| "monthly_recap" \| "milestone_*" |
| created_at | timestamptz | |

### `messages`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| conversation_id | uuid FK → conversations | |
| body | text | SMS body |
| direction | text | "outbound" \| "inbound" |
| sent_by | text | "agent" \| "operator" \| "system" \| "player" |
| status | text | "pending" \| "sent" \| "skipped" \| "failed" \| "undelivered" |
| signup_url | text | Optional program signup link appended to body at send time |
| twilio_message_sid | text | Twilio SID after delivery |
| sent_at | timestamptz | |
| delivery_status | text | Twilio webhook delivery status |
| delivered_at | timestamptz | |
| error_code | text | Twilio error code on failure |
| error_message | text | |
| link_clicked | boolean | Set by Twilio click-tracking webhook |
| link_clicked_at | timestamptz | |
| converted_at | timestamptz | Set when win-back conversion detected |
| template_id | uuid FK → message_templates | If sent from a template |

### `message_templates`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| body | text | May contain `{{first_name}}`, `{{skill_level}}`, `{{last_visit}}`, `{{club_name}}` |
| use_case_tags | text[] | e.g. ["dormant", "lapsing"] |
| is_builtin | boolean | Built-ins cannot be edited or deleted |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### `session_feedback`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| player_id | uuid FK → players | |
| event_id | text | PodPlay event ID |
| level | text | Session level |
| self_fit | integer | 0 = no, 1 = yes (player felt they fit the level) |
| others_fit | integer | 0 = no, 1 = yes |
| responded_at | timestamptz | |
| UNIQUE | (player_id, event_id) | |

### `pending_sends`

Tracks outbound feedback requests that are awaiting a reply.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| player_id | uuid FK → players | |
| conversation_id | uuid | |
| type | text | "session_feedback" |
| sent_at | timestamptz | |
| metadata | jsonb | `{ event_id, level }` |

### `level_confidence`

| Column | Type | Notes |
|---|---|---|
| player_id | uuid FK → players | |
| level | text | Skill level string |
| score | integer | 0–100 composite score |
| certainty | float | 0.0–1.0 |
| sessions | integer | Total attendance count at this level |
| peer_positive | integer | Count of positive "others_fit" feedback from peers |
| peer_total | integer | Total peer feedback events |
| last_computed | timestamptz | |
| PRIMARY KEY | (player_id, level) | |

### `level_taxonomy`

Defines the allowed skill levels per club and their sort order.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| club_id | uuid FK → clubs | |
| level | text | Level label (e.g. "2.5", "3.0+") |
| rank | integer | Sort order (lower = easier) |

### `buddy_pairs`

Stores computed court-buddy relationships. **No `id` column.**

| Column | Type | Notes |
|---|---|---|
| player_a | uuid FK → players | Always the lexicographically smaller UUID |
| player_b | uuid FK → players | |
| shared_sessions | integer | Count of co-attended events in the last 90 days |
| last_shared_at | timestamptz | Most recent shared event |
| opt_in_notifications | boolean | Whether buddy wants alerts (currently unused) |
| updated_at | timestamptz | |
| PRIMARY KEY | (player_a, player_b) | |

### `jobs`

Internal job state table. Managed exclusively by `lib/jobStore.ts`.

| Column | Type | Notes |
|---|---|---|
| id | text PK | Job name e.g. "nightly_sync" |
| status | text | "idle" \| "running" \| "done" \| "error" \| "cancelled" |
| started_at | timestamptz | |
| finished_at | timestamptz | |
| stats | jsonb | Outcome stats |
| error | text | Error message if status = error |
| logs | text[] | Append-only log lines |
| cancel_requested | boolean | Operator cancellation flag |

Known job IDs: `nightly_sync`, `import_players`, `sync_events`, `sync_all`, `compute_confidence`, `confidence_nightly`, `compute_churn_scores`, `monthly_recap`, `milestone_check`.

### `player_milestones`

Deduplication table for milestone messages.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| player_id | uuid FK → players | |
| milestone_type | text | "session_10" \| "session_25" \| "session_50" \| "best_month" \| "streak_3w" |
| milestone_value | integer | For best_month: encoded as YYYYMM integer |
| triggered_at | date | ISO date of when milestone was triggered |
| message_queued | boolean | |
| UNIQUE | (player_id, milestone_type) | Prevents double-triggering (best_month uses milestone_value comparison instead) |

### `monthly_recaps`

Deduplication table for monthly recap messages.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| player_id | uuid FK → players | |
| recap_month | text | Format "YYYY-MM" (e.g. "2026-04") |
| message_queued | boolean | |
| created_at | timestamptz | |
| UNIQUE | (player_id, recap_month) | |

---

## 5. External Integrations

### PodPlay API

Base URL: `https://pbclub.podplay.app/apis/v2`  
Auth: `x-api-key: $PODPLAY_API_KEY` header

Key endpoints used:

| Endpoint | Usage |
|---|---|
| `GET /members?ipp=100&page=N` | Import all club members (pagination) |
| `GET /events?startTime=&endTime=&ipp=100` | Fetch upcoming/recent events |
| `GET /events/:id/signups` | Get list of PodPlay user IDs signed up for an event |
| `GET /members/:id/activity` | Fetch attendance history for a specific member |

Rate limiting: The social graph code uses batches of 3 requests with 250 ms delays between batches to stay within PodPlay's limits. On 429 responses, it sleeps 3 seconds and retries once.

### Anthropic (Claude)

Two model strings in use:
- `claude-sonnet-4-5` — Monthly recap and milestone message generation (shorter, cheaper)
- `claude-sonnet-4-6` — Retention agent (`/api/agent/run`), full player profile + program selection

**Do not use** `claude-sonnet-4-20250514` — this string does not exist and will throw API errors.

The agent uses a large system prompt (~140 lines) stored inline in `routes/agent.ts` that encodes:
- Level trust tiers (trusted/promising/emerging/misfit/unknown)
- Engagement state routing (active/lapsing/dormant)
- Progression routing (ready-to-advance/developing/at-ceiling/lateral-default)
- Social context rules (buddy prioritization)
- Message tone and style guardrails

### Twilio SMS

Used for outbound SMS sending and inbound webhook handling.  
Client is initialized lazily in `lib/twilio.ts` — missing credentials do not crash the server; instead, `getTwilioClient()` throws at call time, which is caught in bulk send to degrade gracefully.

Webhook endpoints (must be configured in Twilio Console):
- `POST /api/messages/webhook/status` — Delivery status + link click tracking
- `POST /api/messages/webhook/inbound` — Inbound replies, STOP/START handling

---

## 6. Backend Systems — Library Layer

### 6.1 Supabase Client (`lib/supabaseClient.ts`)

Exports a single `supabase` client initialized with the **service-role key**. All server-side DB access goes through this singleton. No RLS restrictions apply.

### 6.2 Job Store (`lib/jobStore.ts`)

Provides a lightweight job-tracking system backed by the `jobs` table.

```typescript
startJob(jobId)          // Sets status=running, clears logs, stamps started_at
finishJob(jobId, status, stats?, error?)  // Sets status, stamps finished_at
appendJobLog(jobId, message)             // Appends timestamped string to logs[]
isCancelled(jobId)       // Returns true if cancel_requested=true
requestCancel(jobId)     // Sets cancel_requested=true
getJob(jobId)            // Returns full job row
```

**Important:** `appendJobLog` is called frequently during batch operations and logs timestamps in the format `[HH:MM:SS] message`. The `logs` column holds all lines; the API endpoints slice to `logs.slice(-50)` for the status response.

### 6.3 Scheduler (`lib/scheduler.ts`)

Two independent timers started on server boot via `startScheduler()`:

**Feedback poller** — runs every 30 minutes.  
Calls `sendFeedbackForRecentEvents(log, 0.5)` with a 30-minute lookback window. Finds events that ended in the last 30 minutes and sends post-session feedback SMS to attendees.

**Nightly chain trigger** — runs every 60 seconds.  
Reads `clubs.scheduled_sync_time` and `clubs.timezone` for club `CLUB_ID`. When the current local time matches the scheduled time (minute-resolution), runs `runNightlyChain()`. Skips if nightly job is already running.

See §9 for the full nightly chain breakdown.

### 6.4 Churn Score Engine (`lib/churnScore.ts`)

Computes a 0–100 churn risk score for a single player and writes `churn_score` and `churn_risk` back to the `players` table.

**Score breakdown (max 100):**

| Signal | Max pts | Logic |
|---|---|---|
| S1 Recency | 30 | 10pts if 15–30 days since last visit; 20pts if 31–60 days; 30pts if 61+ days |
| S2 Frequency drop | 25 | Compares baseline weekly rate (first 60 days) to recent weekly rate (last 30 days); neutral prior = 12 if no baseline |
| S3 Social isolation | 20 | 20pts if 0 buddy pairs; 10pts if 1–2; 0pts if 3+ |
| S4 Outreach non-response | 15 | Only applied when ≥3 outbound messages sent. 15pts if 0% reply rate; 8pts if <50%; 0pts otherwise |
| S5 Membership | 10 | 0pts for members; 10pts for non-members |

**Risk thresholds:**
- HIGH: score ≥ 70
- MEDIUM: score 40–69
- LOW: score 0–39

Never-visited players are skipped entirely (no score written).

`computeChurnScoreAndReturn()` is an identical variant that returns the full breakdown for the `/api/sync/churn-scores/test` debug endpoint.

### 6.5 Level Confidence Engine (`lib/levelConfidence.ts`)

Computes how confidently a player is placed at each skill level they have attended. Writes to the `level_confidence` table.

**Score formula (per level):**

1. **Attendance score** (0–70): `min(sessions / 20, 1) × 70`
2. **Self-fit peer score** (0–30): Based on `session_feedback.others_fit` responses from co-attendees.
3. **Coach boost**: If `coach_assigned_level` matches this level, adds 15 points (capped at 100) and raises certainty.
4. **DUPR adjustment**: If `dupr_rating` is set, adjusts score based on DUPR-to-skill-level mapping.

**Certainty** = `min(sessions / 10, 1)` — saturates at 10 sessions.

**Tier mapping** (used by the agent):
| Condition | Tier |
|---|---|
| score ≥ 60 AND certainty ≥ 0.6 | trusted |
| score ≥ 60 AND certainty < 0.6 | promising |
| score 40–59 | emerging |
| score < 40 AND certainty ≥ 0.3 | misfit |
| score < 40 AND certainty < 0.3 | unknown |

Triggered automatically:
- After each `PATCH /api/players/:id/coach-level`
- After each `PATCH /api/players/:id` (DUPR change)
- After each inbound feedback SMS reply
- During the nightly chain (Step 3: incremental recompute)
- Via `POST /api/sync/level-confidence` (full batch)

### 6.6 Post-Session Feedback Engine (`lib/postSessionFeedback.ts`)

After a PodPlay event ends, the system sends each attendee a two-question SMS asking whether they felt the level was right for them and for other players.

**Flow:**
1. `sendFeedbackForRecentEvents(log, windowHours)` — called by the scheduler every 30 minutes with `windowHours=0.5`. Finds events whose end time falls within the window.
2. For each event, calls `sendFeedbackForEvent(eventId, log)`.
3. Fetches attendees from the `attendances` table.
4. For each attendee with a phone and `sms_opt_in=true`:
   - Creates a `conversations` row (`triggered_by: "session_feedback"`)
   - Inserts a `messages` row (status: pending)
   - Inserts a `pending_sends` row (`type: "session_feedback"`, `metadata: { event_id, level }`)
   - Sends via Twilio
5. Message format: `"Hey {first_name}, how did {event_name} feel today? Reply Y/N for yourself, then Y/N for the other players — like 'Y Y' or 'N Y'."`

**Reply parsing (`parseFeedbackReply`):**
Accepts: "Y Y", "Y N", "N Y", "N N", "Y", "N" — case-insensitive, with various separators.

**Inbound handling** (in `routes/messages.ts`):  
When an inbound SMS arrives, the webhook checks `pending_sends` for an unresolved session_feedback for that player. If found and the feedback hasn't been recorded yet, it parses the reply, saves to `session_feedback`, triggers `computeLevelConfidence`, and sends a thank-you.

### 6.7 Monthly Recap Engine (`lib/monthlyRecap.ts`)

Generates and queues a personalized monthly recap SMS for each eligible player.

**Eligibility criteria:**
- `last_visit_date` is not null
- `sms_opt_in` is not false
- `phone` is not null
- `sessionsThisMonth >= 2`
- No existing `monthly_recaps` row for `(player_id, recap_month)` (dedup)

**Stats assembled:**
- Sessions this month
- Total sessions ever (up to end of recap month)
- Unique court partners this month
- Top 3 most frequent partners (name + shared count)
- Whether coach level changed during the recap month

**Claude prompt model:** `claude-sonnet-4-5`, max_tokens: 300

**Nightly trigger:** Step 7 of the nightly chain, only on the 1st of each month.

**`recap_month` format:** `"YYYY-MM"` (e.g. `"2026-04"`)

### 6.8 Milestone Check Engine (`lib/milestoneCheck.ts`)

Checks each player for triggerable milestone events and queues a celebration SMS if one is found.

**Milestone types and trigger conditions:**

| Type | Condition | Cooldown |
|---|---|---|
| `session_10` | total attendances ≥ 10 | Once ever (UNIQUE constraint) |
| `session_25` | total attendances ≥ 25 | Once ever |
| `session_50` | total attendances ≥ 50 | Once ever |
| `best_month` | current month sessions > best prior month (min 3 this month) | Once per calendar month (milestone_value = YYYYMM) |
| `streak_3w` | last 3 distinct ISO weeks are consecutive | 21-day cooldown (triggered_at ≥ 21 days ago) |

Only one milestone is triggered per player per batch run (the first matching one in priority order: 50 → 25 → 10 → best_month → streak_3w).

**`dry_run=true`**: Generates Claude messages for all matching milestones but does not persist anything. Returns `all_previews` array.

**Claude prompt model:** `claude-sonnet-4-5`, max_tokens: 300

**Nightly trigger:** Step 6 of the nightly chain, every night.

### 6.9 Skill Level Extractor (`lib/skillLevel.ts`)

`extractSkillLevel(tags: string[]): string | null`

Parses PodPlay event tags to extract a skill level string. Recognizes patterns like:
- `"2.5"`, `"3.0"`, `"3.5+"`, `"4.0+"`
- Tag prefixes like `"level:2.5"` or `"skill:3.0"`

Used by the social graph routes when building event cards.

### 6.10 Twilio Client (`lib/twilio.ts`)

```typescript
getTwilioClient(): TwilioRestClient  // throws if TWILIO_* env vars missing
sendViaTwilio(to: string, body: string): Promise<string>  // returns SID
```

Reads `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` from environment. Graceful degradation: if Twilio is not configured, bulk send skips Twilio calls and still records message rows with status "sent" (no actual SMS is delivered).

---

## 7. API Reference

All routes are mounted at `/api`. Paths in this section omit the `/api` prefix.

### 7.1 Health

**`GET /healthz`**  
Returns `{ status: "ok", timestamp }`. Used by deployment health checks.

---

### 7.2 Players

**`GET /players/:id/profile`**  
Calls `assembleProfile(id)` — an aggregation function that joins player data, recent attendances, conversations, messages, and level confidence. Returns the full player profile object used by the agent and the PlayerDrawer.

**`POST /players/:id/progression`**  
Body: `{ status: "ready-to-advance" | "developing" | "at-ceiling" | null, assessed_by?: string }`  
Updates `progression_status`, saves previous value to `progression_previous`.

**`PATCH /players/:id/coach-level`**  
Body: `{ coach_assigned_level: string, coach_level_notes?: string, coach_level_set_by?: string }`  
Validates level against `level_taxonomy` for the club. Updates the player record and triggers `computeLevelConfidence` in the background.  
Returns: `{ player, level_confidence[] }`

**`GET /players/:id/confidence`**  
Returns all `level_confidence` rows for the player, sorted by `level_taxonomy.rank` (ascending).

**`PATCH /players/:id`**  
Accepts `{ dupr_rating: number }` (1.0–6.0). Updates `dupr_rating` and `dupr_updated_at`, triggers confidence recompute.

**`GET /players/winback-stats`**  
Returns 30-day outbound SMS stats: `{ period_days, messages_sent, conversions, conversion_rate_pct }`. Never throws — returns zeroes on any error to avoid breaking the dashboard.

---

### 7.3 Agent

**`POST /agent/run`** _(rate limited: 20 req/min)_  
Body: `{ player_id: string }`

Full flow:
1. `assembleProfile(player_id)` + `fetchAvailablePrograms()` in parallel
2. Fetches `level_confidence` rows
3. Computes engagement state from `last_visit_date`
4. Creates `conversations` row (triggered_by = engagement_state)
5. Fetches social context: buddy list, upcoming buddy sessions, player's existing registrations — all non-fatal
6. Filters already-registered events from available programs
7. Calls Claude (`claude-sonnet-4-6`, max_tokens: 4096) with full system prompt + player profile + programs + social context
8. Parses JSON response, resolves `signup_url` for first recommended program
9. Inserts `messages` row (status: "pending")
10. Returns `{ conversation_id, message_id, engagement_state, progression_routing, recommended_programs, message, reasoning, level_assessment }`

---

### 7.4 Sync

**`POST /sync/player`**  
Body: `{ player_id, external_id }`. Synchronizes a single player's attendance history from PodPlay. Returns `{ inserted, updated, errors }`.

**`POST /sync/all`**  
Starts a background job to sync all players with `external_id` whose `last_synced_at` is older than 6 hours. Returns 202 immediately.  
- Checks for already-running job (409 if running)  
- Supports cancellation via `POST /sync/cancel`  
- Poll status: `GET /sync/status`

**`GET /sync/status`**  
Returns job state for `sync_all`: `{ status, startedAt, finishedAt, stats, error, recentLogs[] }`.

**`POST /sync/cancel`**  
Requests cancellation of the running `sync_all` job.

**`POST /sync/events`**  
Starts a background event-centric sync (processes events, not players). Returns 202.

**`GET /sync/events/status`** / **`POST /sync/events/cancel`**

**`POST /sync/nightly`**  
Manually triggers the full nightly chain. Returns 202.

**`GET /sync/nightly/status`**

**`POST /sync/level-confidence`**  
Batch recomputes level confidence for all players who have at least one level-tagged attendance. Returns 202.

**`GET /sync/level-confidence/status`**

**`POST /sync/churn-scores`**  
Batch recomputes churn scores for all players with `last_visit_date` not null. Returns 202. Supports cancellation.

**`GET /sync/churn-scores/status`** / **`POST /sync/churn-scores/cancel`**

**`POST /sync/churn-scores/test`**  
Body: `{ player_id }`. Computes and returns full churn score debug breakdown for a single player.

---

### 7.5 Messages

**`POST /messages/send`**  
Body: `{ message_id: uuid }`  
Sends a pending message via Twilio. Applies pre-flight guards:
1. Message must have status "pending"
2. Player must have `sms_opt_in = true`
3. Player must have a phone number
4. 24-hour cooldown must not be active
5. No unresolved `{{variable}}` tokens  

On success: updates `messages.status = "sent"`, `messages.twilio_message_sid`, `players.last_outbound_at`.

**`POST /messages/skip`**  
Body: `{ message_id }`. Sets status to "skipped".

**`POST /messages/bulk`**  
Body: `{ player_ids: string[], message_body: string, template_id?: string }`  
Sends a templated SMS to multiple players. Interpolates `{{first_name}}`, `{{skill_level}}`, `{{last_visit}}`, `{{club_name}}`. Respects 24-hour cooldown, opt-in, and phone guards. Creates a `conversations` row per player.  
Returns: `{ sent, skipped_cooldown, failed, errors[] }`.

**`POST /messages/webhook/status`**  
Twilio delivery status webhook (`application/x-www-form-urlencoded`). Updates `delivery_status`, `delivered_at`, `error_code`/`error_message` on failure, and `link_clicked`/`link_clicked_at` for click events.

**`POST /messages/webhook/inbound`**  
Twilio inbound SMS webhook. Handles:
- `STOP`/`STOPALL`/etc. → sets `sms_opt_in = false`, cancels all pending messages
- `START`/`YES`/`UNSTOP` → sets `sms_opt_in = true`
- Session feedback reply → parses, saves to `session_feedback`, triggers confidence recompute, sends thanks
- Other replies → threaded into most recent conversation

Always returns TwiML `<Response></Response>` (empty, no auto-reply for regular messages).

---

### 7.6 Feedback

**`POST /feedback/send-post-session`**  
Body: `{ event_id?: string }`. With event_id: processes that event only. Without: processes all events that ended in the last 2 hours. Returns 202; runs in background.

**`POST /feedback/test/send-event`**  
Body: `{ event_id }`. Synchronous — runs and returns stats immediately.

**`POST /feedback/test/poll-now`**  
Triggers a 2-hour lookback immediately. Useful for testing against recently-ended events.

---

### 7.7 Social Graph

**`POST /social-graph/compute-buddy-pairs`**  
Reads all attendances from the last 90 days, computes player pairs who share 3+ events, upserts into `buddy_pairs`. Runs synchronously (may take 10–30s for large datasets).  
Returns: `{ pairs_updated, pairs_above_threshold, pairs_below_threshold }`.

**`GET /social-graph/player/:id/buddies`**  
Returns top 10 buddy pairs for a player, sorted by `shared_sessions` desc.  
Returns: `{ buddies: [{ player_id, name, shared_sessions, last_shared_at, opt_in_notifications }] }`.

**`GET /social-graph/upcoming-with-buddies/:id`**  
Fetches upcoming 7 days of PodPlay events (capped at 10), checks signups for each, returns events where any of the player's buddies are already registered.  
Returns: `{ upcoming: [{ event_id, program_name, level, start_time, buddies_signed_up[] }] }`.

**`GET /social-graph/staff-intro-cards`**  
For each upcoming event, identifies attendees with ≤ 3 prior visits ("new players") and their buddy connections within the same event. Used by the New Player Intros panel in the dashboard.  
Returns: `{ cards: [{ event_id, program_name, level, start_time, new_players[] }] }`.

**`GET /social-graph/player/:id/registrations`**  
Returns upcoming events the player is already registered for.  
Returns: `{ registrations: [{ event_id, event_name, start_time }] }`.

**Test endpoints:**  
`POST /social-graph/test/compute-now` — proxies to compute-buddy-pairs  
`POST /social-graph/test/player-registrations/:id` — proxies to player registrations

---

### 7.8 Templates

**`GET /templates`**  
Returns all templates ordered by `is_builtin DESC, created_at ASC`.

**`POST /templates`**  
Body: `{ name, body, use_case_tags?: string[] }`. Creates a custom template.

**`PATCH /templates/:id`**  
Body: `{ name, body, use_case_tags? }`. Returns 403 if template is built-in.

---

### 7.9 Recap & Milestones

**`POST /recap/monthly`**  
Body: `{ month?: 1-12, year?: 2020+ }`. Defaults to the prior calendar month.  
Fires `runMonthlyRecapBatch` in the background (fire-and-forget).  
Returns: `{ success: true, message: "Monthly recap batch started for YYYY-M" }`.

**`GET /recap/monthly/status`**  
Returns the `monthly_recap` job state.

**`POST /recap/monthly/test`**  
Body: `{ player_id: uuid, month?: number, year?: number, dry_run?: boolean }` (dry_run defaults to true).  
Generates a recap message for one player and returns it. Does not persist if `dry_run=true`.

**`POST /recap/milestones`**  
Fires `runMilestoneBatch` in the background.  
Returns: `{ success: true, message: "Milestone batch started" }`.

**`GET /recap/milestones/status`**  
Returns the `milestone_check` job state.

**`POST /recap/milestones/test`**  
Body: `{ player_id: uuid, dry_run?: boolean }` (dry_run defaults to true).  
Checks one player for milestones and returns preview messages. Does not persist if `dry_run=true`.

---

### 7.10 Import & Admin

**`POST /import/players`**  
Starts a full player import from PodPlay (`importAllPlayers.js`). Returns 202.

**`GET /import/status`**  
Returns `import_players` job state.

**`POST /admin/reset-job/:jobId`**  
Resets a stuck job back to "idle". Operator escape hatch.

---

### 7.11 Programs & Events

**`GET /programs`**  
Calls `fetchAvailablePrograms()` — fetches upcoming PodPlay events for the next 7 days, formats them for the agent prompt.

**`GET /events/:id`** / **`GET /events`**  
Thin proxies to PodPlay event data.

---

## 8. Frontend Pages & Components

The dashboard is a React SPA using React Router. All Supabase queries from the browser go through the anon-key client at `src/lib/supabase.ts`. All API calls go through relative `fetch("/api/...")` which the reverse proxy routes to the API server.

Design system: all styles are inline (no CSS modules or Tailwind). Color palette constants are defined at the top of each page file using `const C = { ... }` or `const D = { ... }`.

### 8.1 Dashboard (`pages/Dashboard.tsx`)

**Data fetched on mount:**
- `clubs` — club name and ID
- `players` — all players, paginated in 1000-row batches. Gracefully falls back if `churn_risk` column is absent.
- `messages` — pending outbound agent messages
- Response rate (outbound/inbound ratio, last 30 days)
- Win-back rate (`GET /api/players/winback-stats`)
- Intro cards (`GET /api/social-graph/staff-intro-cards`)

**Recommendation engine** (`useMemo`):  
Generates up to 4 recommendation tiles based on live player data:

| Rec ID | Urgency | Trigger |
|---|---|---|
| `churn-risk` | critical | highRiskDrifting.length > 0 |
| `needs-outreach` | high | lapsing + dormant > 0 |
| `needs-assessment` | medium | players without progression_status > 0 |
| `twilio-setup` | info | No messages sent in 30 days (signals Twilio not configured) |
| `high-engagement` | good | active > 75% of players |

Tiles are dismissible (stored in `localStorage` with 24-hour TTL).

**Stat strip:** Active / Drifting / Inactive counts + mini horizontal bar chart.

**Bento grid (2-column + sidebar):**
- Row 1 col 1–2: Needs Attention panel (high-churn + lapsing/dormant players, per-player Run Agent button)
- Row 1 col 3: KPI sidebar (Response Rate, Win-Back Rate, Sent This Month, Never Visited)
- Row 2 col 1–2: Outreach Queue (pending agent messages, inline edit/send/dismiss)
- Row 2 col 3: New Player Intros (from social graph, shows new players + buddy connections)

**Sync button:** Triggers `POST /api/sync/events`. Polls `GET /api/sync/events/status` every 15 seconds while running.

### 8.2 Players (`pages/Players.tsx`)

Filterable, sortable table of all players.

**Filters:**  
- Search (name substring)
- Engagement status: Active / Drifting / Inactive / Never Visited / Level Concern (misfit) / High Churn Risk
- Progression: Needs Attention / Move Up / Still Developing / At Their Level
- Membership: Members / Non-members

**Sort columns:** Name, Status, Progress, Skill, Last Visit, Member

**Level Concern filter:** Identifies players with ≥ 2 `session_feedback` rows where `self_fit = 0`.

**Actions:**  
- Export CSV (current filter + sort)
- Send Bulk Outreach (opens `BulkMessageModal`)
- Click row → opens `PlayerDrawer`

### 8.3 Settings (`pages/Settings.tsx`)

Three panels:

**Agent Config:** Displays `clubs.agent_config` JSONB fields as read-only key-value pairs (editable values coming). Known config keys: `max_messages_per_day`, `tone`, `language`, `signup_link_base`, `follow_up_days`, `dormant_threshold_days`, etc.

**Sync & Import Log (`SyncLogPanel`):**  
Polls `GET /api/sync/events/status` and `GET /api/import/status`. Expandable sections showing status badge, last run time, stats, and last 20 log lines.

**Monthly Recap & Milestones (`RecapMilestonesPanel`):**
- Monthly Recap row: shows job status + last run time. "Preview for a player" toggle reveals a UUID input + Generate button that calls `POST /api/recap/monthly/test` with `dry_run=true`. "Run now" triggers `POST /api/recap/monthly`.
- Milestone Messages row: shows job status. "Run check now" triggers `POST /api/recap/milestones`.

**Message Templates:**  
Full CRUD for `message_templates`. Built-in templates are view-only. Custom templates support create, edit, delete. Template editor shows:
- Name field
- Body textarea with live character count (`N chars · M SMS`)
- Tag selector (use-case chips)
- Live preview with variable interpolation (renders resolved values in green, unresolved in amber)

**Schedule:**  
Reads/writes `clubs.scheduled_sync_time` (HH:MM) and `clubs.timezone`. Gracefully hides the form if the columns don't exist.

### 8.4 Messages (`pages/Messages.tsx`)

Conversation-thread view. Lists all conversations with the ability to read message history and see delivery status. (Full details not re-read for this pass — refer to the source file for current implementation.)

### 8.5 Feedback (`pages/Feedback.tsx`)

Displays staff intro cards from the social graph and session feedback data. Shows upcoming new players and their buddy connections. (Refer to source file for current implementation.)

### 8.6 PlayerDrawer (`components/PlayerDrawer.tsx`)

Slide-in side panel loaded by clicking any player row. Fetches `GET /api/players/:id/profile` and renders:
- Engagement state, churn risk badge
- Progression status selector
- Coach level override
- Level confidence bars (per-level scores with tier labels)
- DUPR rating input
- Attendance history timeline
- Notes field
- SMS conversation history
- "Run Agent" button
- Buddy list

---

## 9. Nightly Chain — Step by Step

Triggered at `clubs.scheduled_sync_time` in `clubs.timezone` (checked every 60 seconds).  
Also triggerable manually via `POST /api/sync/nightly`.

Job ID: `nightly_sync`

| Step | Job ID | What it does | Fatal? |
|---|---|---|---|
| 1 | `import_players` | Full PodPlay member import — upserts all players | Yes — chain aborts on failure |
| 2 | `sync_events` | Incremental event attendance sync (last 14 days) | Yes — chain aborts on cancellation |
| 3 | `confidence_nightly` | Recomputes `level_confidence` for players with level-tagged attendances in the last 14 days | No |
| 4 | (inline) | Buddy pairs graph recompute via `POST /api/social-graph/compute-buddy-pairs` (5-min timeout) | No |
| 5 | `compute_churn_scores` | Churn score batch via `POST /api/sync/churn-scores` (10-min timeout) | No |
| 6 | `milestone_check` | Milestone check batch via `POST /api/recap/milestones` (15-min timeout) | No |
| 7 | `monthly_recap` | Monthly recap batch via `POST /api/recap/monthly` (30-min timeout) — **only runs on the 1st of the month** | No |

Steps 4–7 are called via `fetch("http://localhost:$PORT/api/...")` internally. Non-fatal steps log errors but let the chain continue.

---

## 10. Data Sync Pipeline

### Player import (`importAllPlayers.js`)

1. Fetches all PodPlay members via paginated `GET /members?ipp=100&page=N`
2. For each member: upserts `players` row (external_id, name, phone, membership_status, skill_level)
3. Optionally syncs per-player attendance (skipped in the nightly chain — handled by Step 2)

### Event-centric attendance sync (`syncEventAttendance.js`)

1. Fetches PodPlay events for the target date window
2. For each event: fetches signups (`GET /events/:id/signups`)
3. Maps PodPlay external IDs to internal player IDs
4. Upserts `attendances` rows
5. Updates `players.last_visit_date` for each matched player
6. Supports cancellation via `isCancelled()` polling

### Per-player attendance sync (`syncPlayerAttendance.js`)

Alternative path for syncing one player at a time via `GET /members/:id/activity`. Used by `POST /sync/player` and `POST /sync/all`.

---

## 11. SMS & TCPA Compliance

- **Opt-out:** `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` — sets `sms_opt_in = false`, cancels all pending messages
- **Re-subscribe:** `START`, `YES`, `UNSTOP` — sets `sms_opt_in = true`
- **Cooldown:** 24 hours between outbound messages to any player (`COOLDOWN_MS = 24 * 60 * 60 * 1000`)
- **Guard order** (enforced in `/messages/send`): opt-in check → phone check → cooldown check → unresolved variables check
- **Unresolved variables:** Both single-send and bulk-send reject messages containing `{{variable}}` tokens that were not interpolated
- **Unknown numbers:** Inbound SMS from numbers not in the database are still processed for STOP keywords (no-op for START, returns empty TwiML)

---

## 12. Ops Procedures

### Starting / restarting services

Services are managed by Replit workflows. Do not run `pnpm dev` directly.

```
# From Replit agent tools: restart_workflow("artifacts/api-server: API Server")
# From Replit agent tools: restart_workflow("artifacts/dashboard: web")
```

### Triggering a manual sync

```bash
# Event attendance sync (most common)
curl -X POST http://localhost:80/api/sync/events

# Check status
curl http://localhost:80/api/sync/events/status

# Full nightly chain
curl -X POST http://localhost:80/api/sync/nightly
```

### Triggering manual batch jobs

```bash
# Churn scores
curl -X POST http://localhost:80/api/sync/churn-scores

# Level confidence (full recompute)
curl -X POST http://localhost:80/api/sync/level-confidence

# Monthly recap (defaults to prior month)
curl -X POST http://localhost:80/api/recap/monthly \
  -H "Content-Type: application/json" \
  -d '{"month":4,"year":2026}'

# Milestone check
curl -X POST http://localhost:80/api/recap/milestones
```

### Previewing a monthly recap for a specific player

```bash
curl -X POST http://localhost:80/api/recap/monthly/test \
  -H "Content-Type: application/json" \
  -d '{"player_id":"<UUID>","month":4,"year":2026,"dry_run":true}'
```

### Resetting a stuck job

If a job is stuck in "running" state (e.g. after a server restart):

```bash
curl -X POST http://localhost:80/api/admin/reset-job/nightly_sync
```

### Adding a new level to the taxonomy

Run in Supabase SQL Editor:

```sql
INSERT INTO level_taxonomy (club_id, level, rank)
VALUES ('c8976e15-e002-4619-bb4b-b1a70f5cd7ab', '4.5', 8);
```

### Checking player churn score breakdown

```bash
curl -X POST http://localhost:80/api/sync/churn-scores/test \
  -H "Content-Type: application/json" \
  -d '{"player_id":"<UUID>"}'
```

### Running DDL migrations

All schema changes must be run in the **Supabase SQL Editor** for the `knblhxfwvebxntoshiqm` project. The local `DATABASE_URL` points to the Replit local Postgres (used for scripts only) — it does not connect to the production Supabase instance.

---

## 13. Known Issues & Sharp Edges

### Model string sensitivity
Anthropic model strings are exact. `claude-sonnet-4-5` and `claude-sonnet-4-6` are the two valid strings in use. Any typo (e.g. adding a date suffix) will throw at API call time, not at startup.

### `buddy_pairs` has no `id` column
Attempts to do `.select("id")` or `.insert().select("id")` on `buddy_pairs` will fail. The primary key is `(player_a, player_b)`. Always ensure `player_a < player_b` (lexicographic UUID sort) before upsert.

### `churn_risk` column availability
The dashboard code probes for the `churn_risk` column at load time (error code `42703`) and falls back to a select without it. This means if the column is missing from a new Supabase environment, the UI still works — but no churn risk badges appear. Run the migration before deploying to a new environment.

### `last_synced_at` probe in `sync/all`
`runSyncAll()` probes for the `last_synced_at` column with a single-row query. If the column is absent, it falls back to syncing all players regardless of freshness.

### Scheduler uses minute-resolution matching
`isTimeToRun()` checks `nowH === h && nowM === m`. The scheduler tick runs every 60 seconds. If the server is down during the scheduled minute, the nightly chain will not run until the next scheduled time (next day). There is no catch-up logic.

### Social graph endpoints can be slow
`GET /social-graph/staff-intro-cards` and `GET /social-graph/upcoming-with-buddies/:id` make multiple sequential PodPlay API calls (batched 3 at a time with 250 ms delays). With 10 events, expect 3–10 seconds. The dashboard treats these as non-fatal — a timeout or error results in an empty list.

### `streak_3w` ISO week calculation
The milestone engine uses a simplified ISO week computation. It works correctly within a single calendar year but may produce incorrect consecutive-week detection across year boundaries (e.g. week 52 → week 1 of the next year). Known limitation; acceptable for the current use case.

### Agent filters already-registered events
The `/agent/run` endpoint filters programs the player is already registered for from the available programs list before passing to Claude. If `GET /social-graph/player/:id/registrations` fails or times out, no filtering occurs — Claude may recommend a session the player is already booked for.

### Bulk send Twilio graceful degradation
If Twilio is not configured, bulk send still creates `conversations` and `messages` rows (with status "sent") but never actually sends SMS. This is intentional for development/testing but means the `messages` table will have "sent" rows that were never delivered.

### `monthly_recaps` dedup only applies on non-dry-run
`dry_run=true` skips the dedup check. Running the test endpoint multiple times for the same player and month will generate new Claude messages each time (but not persist anything).

### attendances is a tracked-member-only subset (fill must source from API)
`attendances` rows cover only the members we track in Supabase — typically **2–6× fewer** than the true session headcount reported by PodPlay's `signups._total`. This means:
- **Fill rate** (`final_signups / total_teams`) MUST be sourced from the PodPlay API (stored in `event_fill`) — never from counting `attendances` rows.
- Velocity and new-player share CAN use `attendances` but must be labeled "member-subset signals" in any UI or downstream logic, not presented as full-population figures.

### event_fill: fill_rate capped at 100% (2 known overbookings)
Two events in `event_fill` have `fill_rate > 1.0` due to post-signup court edits in PodPlay (capacity was reduced after signups were already recorded). These events are **retained with `fill_rate` clamped to 1.0** in all rating computations — they are not dropped, because the event happened and should count as full. The `is_canceled=false` flag is correct for both. If future overbookings accumulate, add a `WHERE fill_rate <= 1.0` filter only after confirming the cause.

### "Pickleball Fitness HIIT" deliberately left unclassified
`Pickleball Fitness HIIT` (PodPlay type: `Clinics`) does **not** fold into the Workshop archetype. Conditioning is not a skill clinic, and a broad "fitness" keyword risks false matches on future unrelated events. It is treated as an intentional exclusion (stored in `event_fill` with `archetype_id = null`). Revisit as a dedicated archetype if the format recurs consistently (≥5 past events). Do not add "fitness hiit" or "fitness" to Workshop's `match_rules.keywords` without a separate archetype decision.

---

## 14. Onboarding Checklist

For a new developer joining the project:

- [ ] Clone the workspace and ensure pnpm dependencies are installed
- [ ] Confirm all secrets are set in Replit environment: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `PODPLAY_API_KEY`, `SESSION_SECRET`
- [ ] Start both workflows: API Server and Dashboard web
- [ ] Visit `/dashboard/` and confirm the Players page loads with data
- [ ] Run `curl http://localhost:80/api/healthz` — expect `{ "status": "ok" }`
- [ ] Check `GET /api/sync/events/status` — should return a job row (not 404)
- [ ] Read `replit.md` for the current project state and recent changes
- [ ] Read this document, especially §4 (schema), §6 (library layer), and §9 (nightly chain)
- [ ] Understand the Club ID constant — it is hardcoded in several places and must not change
- [ ] Never call `pnpm dev` at the workspace root — use restart_workflow instead
- [ ] All DDL changes go to Supabase SQL Editor, not local migrations
- [ ] When adding new Anthropic calls, use `claude-sonnet-4-5` for short generation tasks and `claude-sonnet-4-6` for the agent

---

## 15. Open Follow-Up Items

### 21. Multi-tenant onboarding flow (Phase 0.5)

Onboarding is currently parked for single-club retention testing:

- `DEFAULT_CLUB_SLUG=pb-club` is shared by API default resolution and the Vite-exposed frontend default. Lookups use `.eq("slug", ...)`, never the first club row.
- Fresh loads of `/` and `/onboarding` redirect to `/dashboard/c/pb-club/dashboard`. The preserved `OnboardingGuard` is not mounted, and stored onboarding flags are unchanged.
- The preserved onboarding API returns 404 for `/api/onboarding/*` while `RETENTION_ONLY_MODE=true`. When unparked, its status route uses `requireClub` rather than first-row fallback.
- Default club resolution is logged at startup; `requireClub` logs each request's resolved ID and includes `X-Resolved-Club-Id` in the response.
- Dashboard read-only counts, player lists, and pending messages are scoped to the active club, including messages without conversations. Retention navigation hides club switching. Authentication/login remain a later phase.
- The separate `test-club` row is preserved. Routing/default changes do not modify SMS dispatch, approvals, kill switches, live mode or test override behavior.

**Required changes for Phase 0.5:**

- Make the route club-scoped: `/c/:slug/onboarding`
- `OnboardingGuard` needs to re-check on club context change — add `club.slug` to its dep array and call the status endpoint with `?slug=<slug>`
- Retain `requireClub` on `GET /api/onboarding/status` and `POST /api/onboarding/complete`
- `POST /api/onboarding/complete` should write `onboarded=true` for the specific club being onboarded

Owner work, not Phase 0. Track separately.

---

## Approved retention platform

Source specification: `attached_assets/Pasted-Goal-refocus-the-platform-on-approved-retention-texts-N_1790805749931.txt`. Rollout and acceptance procedure: `RETENTION_ROLLOUT.md`.

- Migration `artifacts/api-server/migrations/010_retention_approvals.sql` is for the existing external Supabase SQL Editor. It adds message approval/body binding/atomic claims; attendance coupon codes; test-aware, message-idempotent ledger columns; `retention_playbooks`; `retention_candidates`; and service-role-only transactional RPCs. Legacy pending unapproved rows are archived using a fixed cutoff, not deleted.
- The seeded `ltp_followup` playbook uses `LTPNEXT25`, the exact 25% offer and three requested beginner program names, with holdout zero.
- `retentionEngine`, `retentionContext`, `retentionCoupons`, and `retentionText` separate trigger selection, authoritative PodPlay context, coupon validation, and Claude structured-tool text writing. Nightly successful attendance sync invokes draft generation only. `syncEventAttendance.js` now stores signup `couponCode`.
- The Approvals API is club-scoped: list, generate, edit candidate, approve candidate, skip candidate, bulk approve explicit playbook candidate IDs, and change the global kill switch. The canonical contracts are in `lib/api-spec/openapi.yaml`.
- Individual approval includes `expected_body`; bulk approval includes an `expected_bodies` snapshot keyed by candidate ID. The RPC compares the reviewed text under row locks before approving. Changes revoke approval and schedule. Stale approval requests do not authorize newer text.
- Shared `sendViaTwilio` is the authority for approvals, final-body/recipient matching, eligibility, dispatch claims, TCPA windows, fail-closed kill reads, promo revalidation and real-send ledger bookkeeping. Test redirects are not original-player contacts; simulations have no ledger row.
- The `/c/:slug/approvals` page displays each message beside its code-built facts, coupon/schema warnings, review controls, operator-label attribution and global pause controls. Legacy pages are parked by navigation mode, not removed.
- Retention-only parking covers automatic feedback replies/scheduling, recap/milestone generation, programming evaluation and experiment dispatch. Approval remains mandatory across all modes and sending paths.

See the rollout guide for what must be verified before enabling live delivery. Existing unauthenticated dashboard access and unrelated dashboard dependency/type-check failures are not solved by this feature.

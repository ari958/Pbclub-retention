Generated: 2026-09-30T21:26:42.164Z
# Platform state

Regenerate with `npm run snapshot`. Database reads use the project's Supabase service-role client.
Source: current repository files, live database metadata/counts/jobs, and Git. No memory or project notes are read.
Counts are exact at each request time; this report is not a single transactional database snapshot.

## Coverage and limitations

- Catalog coverage is limited to public relations exposed to the service role by PostgREST. Unexposed tables cannot be discovered, and OpenAPI may include views. Install scripts/snapshot-metadata.sql for every public base table.
- Applied migrations are UNKNOWN: no readable migration ledger was found. SQL filenames and existing columns do not prove a migration ran.
- Schema source: live service-role PostgREST OpenAPI.
- Migration files are an inventory only; applied status comes exclusively from a live migration ledger.
- Environment classifications below are static evidence, not proof that a variable is configured at runtime.
- Snapshot generation performs no database updates and sends no messages.

## Public schema (27 exposed relations)

### public.attendances
Live rows: **9,865**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `player_id` | `uuid` |
| `club_id` | `uuid` |
| `program_name` | `text` |
| `program_type` | `text` |
| `attended_at` | `date` |
| `source` | `text` |
| `created_at` | `timestamp with time zone` |
| `event_id` | `text` |
| `level` | `text` |
| `session_type` | `text` |
| `booked_at` | `timestamp with time zone` |
| `updated_at` | `timestamp with time zone` |

### public.buddy_pairs
Live rows: **1,311**

| Column | PostgreSQL type |
| --- | --- |
| `player_a` | `uuid` |
| `player_b` | `uuid` |
| `shared_sessions` | `integer` |
| `last_shared_at` | `date` |
| `opt_in_notifications` | `boolean` |
| `updated_at` | `timestamp with time zone` |

- **public.clubs** — 2 rows; 18 columns. `uuid`: `id`; `text`: `name`, `business_type`, `booking_platform`, `booking_api_key`, `twilio_number`, `timezone`, `platform`, `platform_api_key`, `platform_org_id`, `cr_rating_category_id`, `slug`, `platform_subdomain`; `jsonb`: `agent_config`; `timestamp with time zone`: `created_at`; `time without time zone`: `scheduled_sync_time`; `boolean`: `onboarded`, `sms_kill_switch`
### public.contact_ledger
Live rows: **0**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `club_id` | `uuid` |
| `player_id` | `uuid` |
| `source` | `text` |
| `purpose` | `text` |
| `channel` | `text` |
| `decision_id` | `uuid` |
| `sent_at` | `timestamp with time zone` |
| `outcome` | `text` |
| `created_at` | `timestamp with time zone` |
| `updated_at` | `timestamp with time zone` |
| `experiment_id` | `uuid` |

### public.conversations
Live rows: **770**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `player_id` | `uuid` |
| `club_id` | `uuid` |
| `triggered_by` | `text` |
| `programs_offered` | `text[]` |
| `outcome` | `text` |
| `outcome_program` | `text` |
| `attributed_booking` | `boolean` |
| `attributed_at` | `timestamp with time zone` |
| `attributed_program` | `text` |
| `opened_at` | `timestamp with time zone` |
| `closed_at` | `timestamp with time zone` |
| `updated_at` | `timestamp with time zone` |

### public.event_fill
Live rows: **1,062**

| Column | PostgreSQL type |
| --- | --- |
| `event_id` | `text` |
| `club_id` | `uuid` |
| `archetype_id` | `uuid` |
| `total_teams` | `integer` |
| `final_signups` | `integer` |
| `fill_rate` | `numeric` |
| `start_time` | `timestamp with time zone` |
| `is_daily_peak` | `boolean` |
| `is_peak_season` | `boolean` |
| `is_canceled` | `boolean` |
| `fetched_at` | `timestamp with time zone` |
| `event_name` | `text` |
| `podplay_type` | `text` |

- **public.experiment_participants** — 742 rows; 18 columns. `uuid`: `id`, `experiment_id`, `player_id`; `text`: `arm`, `veto_reason`, `message_text`, `channel`; `integer`: `rank`; `numeric`: `score`; `jsonb`: `reasons`; `boolean`: `vetoed`, `booked_target_session`, `attended_within_30d`; `timestamp with time zone`: `sent_at`, `first_attendance_at`, `outcome_measured_at`, `created_at`, `updated_at`
### public.job_logs
Live rows: **7,317**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `bigint` |
| `job_id` | `text` |
| `logged_at` | `timestamp with time zone` |
| `level` | `text` |
| `message` | `text` |
| `context` | `jsonb` |

### public.jobs
Live rows: **14**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `text` |
| `status` | `text` |
| `started_at` | `timestamp with time zone` |
| `finished_at` | `timestamp with time zone` |
| `stats` | `jsonb` |
| `error` | `text` |
| `logs` | `jsonb` |
| `updated_at` | `timestamp with time zone` |
| `last_heartbeat` | `timestamp with time zone` |

### public.level_confidence
Live rows: **1,368**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `player_id` | `uuid` |
| `level` | `text` |
| `sessions` | `integer` |
| `days_since_last` | `integer` |
| `peer_positive` | `integer` |
| `peer_total` | `integer` |
| `score` | `numeric` |
| `certainty` | `numeric` |
| `last_computed` | `timestamp with time zone` |

### public.level_history
Live rows: **0**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `bigint` |
| `player_id` | `uuid` |
| `club_id` | `uuid` |
| `from_level` | `text` |
| `to_level` | `text` |
| `from_rank` | `integer` |
| `to_rank` | `integer` |
| `source` | `text` |
| `note` | `text` |
| `assigned_at` | `timestamp with time zone` |
| `created_at` | `timestamp with time zone` |

### public.level_taxonomy
Live rows: **6**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `integer` |
| `club_id` | `uuid` |
| `level` | `text` |
| `rank` | `integer` |

### public.message_templates
Live rows: **4**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `name` | `text` |
| `body` | `text` |
| `use_case_tags` | `text[]` |
| `is_builtin` | `boolean` |
| `created_at` | `timestamp with time zone` |
| `updated_at` | `timestamp with time zone` |

- **public.messages** — 682 rows; 26 columns. `uuid`: `id`, `conversation_id`, `player_id`; `text`: `direction`, `body`, `sent_by`, `signup_url`, `twilio_message_sid`, `status`, `delivery_status`, `error_code`, `error_message`, `reply_sentiment`, `link_strategy`, `send_strategy`; `boolean`: `link_clicked`, `ignored`, `simulated`; `timestamp with time zone`: `link_clicked_at`, `sent_at`, `delivered_at`, `converted_at`, `read_at`, `scheduled_send_at`, `updated_at`, `created_at`
### public.monthly_recaps
Live rows: **0**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `player_id` | `uuid` |
| `recap_month` | `text` |
| `message_queued` | `boolean` |
| `queued_at` | `timestamp with time zone` |

- **public.outreach_experiments** — 9 rows; 16 columns. `uuid`: `id`, `club_id`, `decision_id`; `text`: `name`, `event_id`, `event_name`, `status`, `notes`, `randomization_seed`; `timestamp with time zone`: `event_start`, `randomized_at`, `sent_at`, `created_at`, `updated_at`; `numeric`: `treatment_pct`; `integer`: `pool_size`
### public.player_milestones
Live rows: **339**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `player_id` | `uuid` |
| `milestone_type` | `text` |
| `milestone_value` | `integer` |
| `triggered_at` | `date` |
| `message_queued` | `boolean` |

- **public.players** — 2,820 rows; 39 columns. `uuid`: `id`, `club_id`; `text`: `external_id`, `name`, `phone`, `skill_level`, `membership_status`, `progression_status`, `notes`, `email`, `progression_assessed_by`, `progression_previous`, `coach_assigned_level`, `coach_level_notes`, `coach_level_set_by`, `churn_risk`, `attendance_archetype`, `consent_source`; `date`: `last_visit_date`; `boolean`: `opted_out`, `sms_opt_in`; `timestamp with time zone`: `created_at`, `last_synced_at`, `last_outbound_at`, `progression_assessed_at`, `coach_level_set_at`, `dupr_updated_at`, `warm_score_updated_at`, `timing_computed_at`, `updated_at`, `sms_consented_at`, `dupr_checked_at`; `numeric`: `dupr_rating`, `avg_booking_lead_days`; `integer`: `churn_score`, `warm_score`, `preferred_send_hour`, `preferred_booking_dow`, `preferred_booking_hour`
### public.program_ratings
Live rows: **46**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `program_id` | `uuid` |
| `club_id` | `uuid` |
| `daily_peak` | `boolean` |
| `season` | `text` |
| `fill_rate` | `numeric` |
| `event_count` | `integer` |
| `median_velocity_days` | `numeric` |
| `new_player_share` | `numeric` |
| `modal_price_regular` | `numeric` |
| `modal_price_member` | `numeric` |
| `computed_at` | `timestamp with time zone` |
| `created_at` | `timestamp with time zone` |

- **public.programming_decisions** — 34 rows; 24 columns. `uuid`: `id`, `club_id`, `rule_id`, `archetype_id`; `text`: `event_id`, `rule_name`, `event_name`, `decision`, `mode`; `integer`: `checkpoint_index`, `signup_count`, `total_teams`, `checkpoint_offset_hours`, `checkpoint_min_signups`, `native_threshold`; `timestamp with time zone`: `evaluated_at`, `event_start_time`, `created_at`, `updated_at`, `approved_at`; `numeric`: `hours_before_start`, `native_hours_before`; `boolean`: `executed`, `native_would_cancel`
### public.programming_notifications
Live rows: **0**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `decision_id` | `uuid` |
| `player_id` | `uuid` |
| `channel` | `text` |
| `status` | `text` |
| `created_at` | `timestamp with time zone` |
| `updated_at` | `timestamp with time zone` |

### public.programming_rules
Live rows: **3**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `club_id` | `uuid` |
| `name` | `text` |
| `enabled` | `boolean` |
| `match_rules` | `jsonb` |
| `checkpoints` | `jsonb` |
| `mode` | `text` |
| `created_at` | `timestamp with time zone` |
| `updated_at` | `timestamp with time zone` |
| `contact_budget` | `jsonb` |

- **public.programs** — 15 rows; 20 columns. `uuid`: `id`, `club_id`; `text`: `name`, `description`, `program_type`, `skill_level`, `canonical_name`, `canonical_type`, `source_event_id`; `numeric`: `price`; `integer`: `spots_remaining`, `match_priority`; `date`: `start_date`, `end_date`; `boolean`: `is_active`, `overrides_podplay_type`, `active`; `timestamp with time zone`: `created_at`, `updated_at`; `jsonb`: `match_rules`
### public.promotion_candidates
Live rows: **5,009**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `decision_id` | `uuid` |
| `player_id` | `uuid` |
| `rank` | `integer` |
| `score` | `numeric` |
| `reasons` | `jsonb` |
| `eligible` | `boolean` |
| `ineligible_reason` | `text` |
| `created_at` | `timestamp with time zone` |
| `updated_at` | `timestamp with time zone` |

### public.reply_expectations
Live rows: **8**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `player_id` | `uuid` |
| `kind` | `text` |
| `metadata` | `jsonb` |
| `conversation_id` | `uuid` |
| `sent_at` | `timestamp with time zone` |
| `created_at` | `timestamp with time zone` |
| `expires_at` | `timestamp with time zone` |
| `resolved_at` | `timestamp with time zone` |
| `resolution` | `text` |

### public.session_feedback
Live rows: **0**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `player_id` | `uuid` |
| `event_id` | `text` |
| `level` | `text` |
| `responded_at` | `timestamp with time zone` |
| `self_fit` | `integer` |
| `others_fit` | `integer` |

### public.sms_consent_records
Live rows: **1,895**

| Column | PostgreSQL type |
| --- | --- |
| `id` | `uuid` |
| `club_id` | `uuid` |
| `player_id` | `uuid` |
| `email` | `text` |
| `phone_e164` | `text` |
| `first_name` | `text` |
| `last_name` | `text` |
| `consented_at` | `timestamp with time zone` |
| `consent_source` | `text` |
| `import_batch` | `text` |
| `matched` | `boolean` |
| `created_at` | `timestamp with time zone` |
| `updated_at` | `timestamp with time zone` |


## Applied migrations

**UNKNOWN — no readable migration ledger.** Manual SQL Editor runs may never have been recorded.
Do not treat the source-file inventory below as a list of applied migrations.

### Migration SQL in source (application status NOT inferred)

- `artifacts/api-server/migrations/004_programming_tables.sql`
- `artifacts/api-server/migrations/005_event_fill_columns.sql`
- `artifacts/api-server/migrations/006_phase3_hardening.sql`
- `artifacts/api-server/migrations/007_experiments.sql`
- `artifacts/api-server/migrations/008_approved_at.sql`
- `artifacts/api-server/migrations/008_sms_consent.sql`
- `artifacts/api-server/migrations/009_contact_ledger_reconcile.sql`
- `artifacts/api-server/migrations/010_dupr_incremental.sql`
- `migrations/007_contact_ledger.sql`
- `migrations/CURRICULUM_FLOW_001_level_history.sql`
- `migrations/CURRICULUM_FLOW_002_backfill_seed.sql`
- `migrations/PROGRAM_CATALOG_001_setup.sql`
- `migrations/PROGRAM_CATALOG_002_event_fill.sql`
- `supabase/migrations/20260503_onboarding.sql`
- `supabase/migrations/20260506_booked_at.sql`
- `supabase/migrations/20260506_player_timing.sql`
- `supabase/migrations/20260506_warm_score.sql`

## Express routes (101)

Paths include statically resolved router mounts. Dynamic/regex paths are labeled rather than omitted.
| Method | Path | File:line |
| --- | --- | --- |
| GET | `/` | `artifacts/api-server/src/app.ts:34` |
| GET | `/onboarding` | `artifacts/api-server/src/app.ts:35` |
| POST | `/api/admin/dedupe-attendances` | `artifacts/api-server/src/routes/admin.ts:37` |
| GET | `/api/admin/dedupe-attendances/status` | `artifacts/api-server/src/routes/admin.ts:81` |
| POST | `/api/agent/run` | `artifacts/api-server/src/routes/agent.ts:123` |
| GET | `/api/clubs/` | `artifacts/api-server/src/routes/clubs.ts:9` |
| GET | `/api/clubs/by-slug/:slug` | `artifacts/api-server/src/routes/clubs.ts:25` |
| PATCH | `/api/clubs/:id/settings` | `artifacts/api-server/src/routes/clubs.ts:63` |
| POST | `/api/consent/import` | `artifacts/api-server/src/routes/consent.ts:42` |
| GET | `/api/consent/records` | `artifacts/api-server/src/routes/consent.ts:201` |
| GET | `/api/events/upcoming` | `artifacts/api-server/src/routes/events.ts:85` |
| GET | `/api/experiments/eligible-sessions` | `artifacts/api-server/src/routes/experiments.ts:519` |
| POST | `/api/experiments/preview` | `artifacts/api-server/src/routes/experiments.ts:553` |
| POST | `/api/experiments` | `artifacts/api-server/src/routes/experiments.ts:624` |
| GET | `/api/experiments` | `artifacts/api-server/src/routes/experiments.ts:775` |
| GET | `/api/experiments/pooled-results` | `artifacts/api-server/src/routes/experiments.ts:827` |
| GET | `/api/experiments/:id` | `artifacts/api-server/src/routes/experiments.ts:900` |
| POST | `/api/experiments/:id/veto/:pid` | `artifacts/api-server/src/routes/experiments.ts:931` |
| PATCH | `/api/experiments/:id/participants/:pid` | `artifacts/api-server/src/routes/experiments.ts:956` |
| POST | `/api/experiments/:id/mark-sent` | `artifacts/api-server/src/routes/experiments.ts:982` |
| POST | `/api/experiments/:id/measure` | `artifacts/api-server/src/routes/experiments.ts:1071` |
| GET | `/api/experiments/:id/measure/status` | `artifacts/api-server/src/routes/experiments.ts:1178` |
| POST | `/api/experiments/:id/send` | `artifacts/api-server/src/routes/experiments.ts:1196` |
| POST | `/api/feedback/send-post-session` | `artifacts/api-server/src/routes/feedback.ts:14` |
| POST | `/api/feedback/test/send-event` | `artifacts/api-server/src/routes/feedback.ts:41` |
| POST | `/api/feedback/test/poll-now` | `artifacts/api-server/src/routes/feedback.ts:60` |
| GET | `/api/healthz` | `artifacts/api-server/src/routes/health.ts:6` |
| POST | `/api/import/players` | `artifacts/api-server/src/routes/import.ts:18` |
| POST | `/api/import/cancel` | `artifacts/api-server/src/routes/import.ts:81` |
| GET | `/api/import/status` | `artifacts/api-server/src/routes/import.ts:101` |
| POST | `/api/import/phone-numbers` | `artifacts/api-server/src/routes/import.ts:115` |
| GET | `/api/import/phone-numbers/status` | `artifacts/api-server/src/routes/import.ts:157` |
| POST | `/api/import/phone-numbers/cancel` | `artifacts/api-server/src/routes/import.ts:169` |
| POST | `/api/import/dupr` | `artifacts/api-server/src/routes/import.ts:187` |
| GET | `/api/import/dupr/status` | `artifacts/api-server/src/routes/import.ts:234` |
| POST | `/api/import/dupr/cancel` | `artifacts/api-server/src/routes/import.ts:246` |
| POST | `/api/messages/send` | `artifacts/api-server/src/routes/messages.ts:60` |
| POST | `/api/messages/skip` | `artifacts/api-server/src/routes/messages.ts:214` |
| POST | `/api/messages/bulk` | `artifacts/api-server/src/routes/messages.ts:256` |
| POST | `/api/messages/webhook/status` | `artifacts/api-server/src/routes/messages.ts:415` |
| POST | `/api/messages/webhook/inbound` | `artifacts/api-server/src/routes/messages.ts:467` |
| PATCH | `/api/messages/:id/draft` | `artifacts/api-server/src/routes/messages.ts:685` |
| GET | `/api/onboarding/status` | `artifacts/api-server/src/routes/onboarding.ts:15` |
| POST | `/api/onboarding/validate` | `artifacts/api-server/src/routes/onboarding.ts:81` |
| POST | `/api/onboarding/complete` | `artifacts/api-server/src/routes/onboarding.ts:166` |
| GET | `/api/players` | `artifacts/api-server/src/routes/players.ts:28` |
| GET | `/api/players/:id/profile` | `artifacts/api-server/src/routes/players.ts:61` |
| POST | `/api/players/:id/progression` | `artifacts/api-server/src/routes/players.ts:101` |
| PATCH | `/api/players/:id/coach-level` | `artifacts/api-server/src/routes/players.ts:152` |
| PATCH | `/api/players/:id/notes` | `artifacts/api-server/src/routes/players.ts:214` |
| PATCH | `/api/players/:id/coach-level-notes` | `artifacts/api-server/src/routes/players.ts:247` |
| GET | `/api/players/:id/confidence` | `artifacts/api-server/src/routes/players.ts:276` |
| PATCH | `/api/players/:id` | `artifacts/api-server/src/routes/players.ts:320` |
| GET | `/api/players/winback-stats` | `artifacts/api-server/src/routes/players.ts:364` |
| POST | `/api/programming/evaluate` | `artifacts/api-server/src/routes/programming.ts:81` |
| GET | `/api/programming/evaluate/status` | `artifacts/api-server/src/routes/programming.ts:130` |
| GET | `/api/programming/queue` | `artifacts/api-server/src/routes/programming.ts:148` |
| PATCH | `/api/programming/decisions/:id/approve` | `artifacts/api-server/src/routes/programming.ts:215` |
| GET | `/api/programming/decisions` | `artifacts/api-server/src/routes/programming.ts:258` |
| GET | `/api/programming/upcoming-risk` | `artifacts/api-server/src/routes/programming.ts:289` |
| POST | `/api/programming/backfill-fill` | `artifacts/api-server/src/routes/programming.ts:434` |
| GET | `/api/programming/backfill-fill/status` | `artifacts/api-server/src/routes/programming.ts:553` |
| POST | `/api/programming/backtest` | `artifacts/api-server/src/routes/programming.ts:613` |
| POST | `/api/programming/batch-timing` | `artifacts/api-server/src/routes/programming.ts:1071` |
| GET | `/api/programming/rules` | `artifacts/api-server/src/routes/programming.ts:1087` |
| POST | `/api/programming/rules/seed-phase3` | `artifacts/api-server/src/routes/programming.ts:1105` |
| GET | `/api/programming/promotion-candidates/:decisionId` | `artifacts/api-server/src/routes/programming.ts:1254` |
| GET | `/api/programs` | `artifacts/api-server/src/routes/programs.ts:11` |
| GET | `/api/programs/catalog` | `artifacts/api-server/src/routes/programs.ts:44` |
| POST | `/api/queue/poll-now` | `artifacts/api-server/src/routes/queue.ts:6` |
| POST | `/api/recap/monthly` | `artifacts/api-server/src/routes/recap.ts:29` |
| GET | `/api/recap/monthly/status` | `artifacts/api-server/src/routes/recap.ts:48` |
| POST | `/api/recap/monthly/test` | `artifacts/api-server/src/routes/recap.ts:60` |
| POST | `/api/recap/milestones` | `artifacts/api-server/src/routes/recap.ts:82` |
| GET | `/api/recap/milestones/status` | `artifacts/api-server/src/routes/recap.ts:92` |
| POST | `/api/recap/milestones/test` | `artifacts/api-server/src/routes/recap.ts:102` |
| POST | `/api/social-graph/compute-buddy-pairs` | `artifacts/api-server/src/routes/socialGraph.ts:83` |
| GET | `/api/social-graph/player/:id/buddies` | `artifacts/api-server/src/routes/socialGraph.ts:95` |
| GET | `/api/social-graph/upcoming-with-buddies/:id` | `artifacts/api-server/src/routes/socialGraph.ts:108` |
| GET | `/api/social-graph/staff-intro-cards` | `artifacts/api-server/src/routes/socialGraph.ts:121` |
| GET | `/api/social-graph/player/:id/registrations` | `artifacts/api-server/src/routes/socialGraph.ts:232` |
| POST | `/api/social-graph/test/player-registrations/:id` | `artifacts/api-server/src/routes/socialGraph.ts:245` |
| POST | `/api/social-graph/test/compute-now` | `artifacts/api-server/src/routes/socialGraph.ts:265` |
| POST | `/api/sync/player` | `artifacts/api-server/src/routes/sync.ts:137` |
| POST | `/api/sync/all` | `artifacts/api-server/src/routes/sync.ts:173` |
| POST | `/api/sync/cancel` | `artifacts/api-server/src/routes/sync.ts:211` |
| GET | `/api/sync/status` | `artifacts/api-server/src/routes/sync.ts:231` |
| POST | `/api/sync/events` | `artifacts/api-server/src/routes/sync.ts:245` |
| GET | `/api/sync/events/status` | `artifacts/api-server/src/routes/sync.ts:283` |
| POST | `/api/sync/events/cancel` | `artifacts/api-server/src/routes/sync.ts:296` |
| POST | `/api/sync/nightly` | `artifacts/api-server/src/routes/sync.ts:310` |
| GET | `/api/sync/nightly/status` | `artifacts/api-server/src/routes/sync.ts:337` |
| POST | `/api/sync/level-confidence` | `artifacts/api-server/src/routes/sync.ts:354` |
| GET | `/api/sync/level-confidence/status` | `artifacts/api-server/src/routes/sync.ts:414` |
| POST | `/api/sync/churn-scores` | `artifacts/api-server/src/routes/sync.ts:428` |
| GET | `/api/sync/churn-scores/status` | `artifacts/api-server/src/routes/sync.ts:439` |
| POST | `/api/sync/churn-scores/cancel` | `artifacts/api-server/src/routes/sync.ts:451` |
| POST | `/api/sync/churn-scores/test` | `artifacts/api-server/src/routes/sync.ts:456` |
| GET | `/api/templates` | `artifacts/api-server/src/routes/templates.ts:8` |
| POST | `/api/templates` | `artifacts/api-server/src/routes/templates.ts:26` |
| PATCH | `/api/templates/:id` | `artifacts/api-server/src/routes/templates.ts:60` |

## Feature flags and environment variable names (26)

Required = explicit source evidence (validation/throw or non-null assertion). Otherwise requiredness is not established.
Feature flag = boolean comparison, flag-style name, or navigation mode. No values, defaults, or configuration state are included.
| Name | Required by source | Feature flag | References |
| --- | --- | --- | --- |
| `ANTHROPIC_AGENT_MODEL` | Not established | No | `artifacts/api-server/src/lib/anthropicConfig.ts:15` |
| `ANTHROPIC_API_KEY` | Not established | No | `artifacts/api-server/src/lib/milestoneCheck.ts:6`, `artifacts/api-server/src/lib/monthlyRecap.ts:7`, `artifacts/api-server/src/routes/agent.ts:38` |
| `API_PORT` | Not established | No | `artifacts/dashboard/vite.config.ts:70` |
| `BASE_PATH` | Yes | No | `artifacts/dashboard/vite.config.ts:21`, `artifacts/mockup-sandbox/vite.config.ts:22` |
| `BASE_URL` | Not established | No | `artifacts/dashboard/src/App.tsx:150`, `artifacts/dashboard/src/App.tsx:276`, `artifacts/dashboard/src/pages/Programs.tsx:37`, `artifacts/mockup-sandbox/src/App.tsx:91` |
| `CLUB_ID` | Not established | No | `artifacts/api-server/src/scripts/auditCurriculumCoverage.ts:27`, `artifacts/api-server/src/scripts/seedSyntheticCoachLevels.ts:26` |
| `DATABASE_URL` | Yes | No | `lib/db/drizzle.config.ts:12`, `lib/db/drizzle.config.ts:4`, `lib/db/src/index.ts:13`, `lib/db/src/index.ts:7` |
| `LOG_LEVEL` | Not established | No | `artifacts/api-server/src/lib/logger.ts:6` |
| `NODE_ENV` | Not established | No | `artifacts/api-server/src/lib/logger.ts:3`, `artifacts/api-server/src/routes/agent.ts:136`, `artifacts/api-server/src/routes/experiments.ts:1373`, `artifacts/mockup-sandbox/vite.config.ts:37` |
| `PODPLAY_API_KEY` | Yes | No | `artifacts/api-server/src/fetchAvailablePrograms.js:108`, `artifacts/api-server/src/fetchAvailablePrograms.js:92`, `artifacts/api-server/src/importAllPlayers.js:119`, `artifacts/api-server/src/importAllPlayers.js:273`, `artifacts/api-server/src/importPhoneNumbers.js:78`, `artifacts/api-server/src/lib/eventFillSync.ts:89`, `artifacts/api-server/src/lib/postSessionFeedback.ts:116`, `artifacts/api-server/src/lib/programmingEvaluator.ts:86`, `artifacts/api-server/src/lib/socialGraph.ts:114`, `artifacts/api-server/src/routes/events.ts:102`, `artifacts/api-server/src/routes/experiments.ts:1006`, `artifacts/api-server/src/routes/experiments.ts:1264`, `artifacts/api-server/src/routes/experiments.ts:569`, `artifacts/api-server/src/routes/experiments.ts:636`, `artifacts/api-server/src/routes/programming.ts:1297`, `artifacts/api-server/src/routes/programming.ts:305`, `artifacts/api-server/src/routes/programming.ts:477`, `artifacts/api-server/src/routes/socialGraph.ts:131`, `artifacts/api-server/src/scripts/backfillEventFillMetadata.ts:39`, `artifacts/api-server/src/scripts/reclassifyEventFill.ts:36`, `artifacts/api-server/src/syncEventAttendance.js:203` |
| `POLL_INTERVAL_MS` | Not established | No | `artifacts/api-server/src/lib/queuePoller.ts:7` |
| `PORT` | Yes | No | `artifacts/api-server/src/index.ts:7`, `artifacts/api-server/src/routes/socialGraph.ts:246`, `artifacts/dashboard/vite.config.ts:7`, `artifacts/mockup-sandbox/vite.config.ts:8` |
| `PUBLIC_API_URL` | Not established | No | `artifacts/api-server/src/lib/twilio.ts:46`, `artifacts/api-server/src/lib/twilio.ts:47` |
| `REPL_ID` | Not established | No | `artifacts/mockup-sandbox/vite.config.ts:38` |
| `SMS_LIVE` | Not established | Yes | `artifacts/api-server/src/lib/twilio.ts:30`, `artifacts/api-server/src/routes/experiments.ts:1277` |
| `SMS_TEST_OVERRIDE_TO` | Not established | Yes | `artifacts/api-server/src/lib/twilio.ts:31`, `artifacts/api-server/src/routes/experiments.ts:1276` |
| `SUPABASE_ANON_KEY` | Not established | No | `artifacts/dashboard/vite.config.ts:34` |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | No | `artifacts/api-server/scripts/threshold-sweep.mjs:18`, `artifacts/api-server/src/assembleProfile.js:5`, `artifacts/api-server/src/dedupeAttendances.js:5`, `artifacts/api-server/src/fetchAvailablePrograms.js:8`, `artifacts/api-server/src/importAllPlayers.js:7`, `artifacts/api-server/src/importPhoneNumbers.js:5`, `artifacts/api-server/src/lib/supabaseClient.ts:27`, `artifacts/api-server/src/migrate_feedback.mjs:5`, `artifacts/api-server/src/migrate_templates.mjs:5`, `artifacts/api-server/src/routes/import.ts:47`, `artifacts/api-server/src/scripts/compareAgentModels.ts:42`, `artifacts/api-server/src/scripts/dryRunCatalog.ts:22`, `artifacts/api-server/src/scripts/importSmsConsent.js:22`, `artifacts/api-server/src/scripts/patchKeywords.ts:62`, `artifacts/api-server/src/syncEventAttendance.js:10`, `artifacts/api-server/src/syncPlayerAttendance.js:14` |
| `SUPABASE_URL` | Yes | No | `artifacts/api-server/scripts/threshold-sweep.mjs:17`, `artifacts/api-server/src/assembleProfile.js:4`, `artifacts/api-server/src/dedupeAttendances.js:4`, `artifacts/api-server/src/fetchAvailablePrograms.js:7`, `artifacts/api-server/src/importAllPlayers.js:6`, `artifacts/api-server/src/importPhoneNumbers.js:4`, `artifacts/api-server/src/lib/supabaseClient.ts:26`, `artifacts/api-server/src/migrate_feedback.mjs:4`, `artifacts/api-server/src/migrate_templates.mjs:4`, `artifacts/api-server/src/scripts/compareAgentModels.ts:41`, `artifacts/api-server/src/scripts/dryRunCatalog.ts:21`, `artifacts/api-server/src/scripts/importSmsConsent.js:21`, `artifacts/api-server/src/scripts/patchKeywords.ts:61`, `artifacts/api-server/src/syncEventAttendance.js:9`, `artifacts/api-server/src/syncPlayerAttendance.js:13`, `artifacts/dashboard/vite.config.ts:33` |
| `TWILIO_ACCOUNT_SID` | Yes | No | `artifacts/api-server/src/lib/postSessionFeedback.ts:198`, `artifacts/api-server/src/lib/twilio.ts:5` |
| `TWILIO_AUTH_TOKEN` | Yes | No | `artifacts/api-server/src/lib/postSessionFeedback.ts:198`, `artifacts/api-server/src/lib/twilio.ts:6` |
| `TWILIO_MESSAGING_SERVICE_SID` | Not established | No | `artifacts/api-server/src/lib/twilio.ts:41` |
| `TWILIO_PHONE_NUMBER` | Not established | No | `artifacts/api-server/src/lib/twilio.ts:45` |
| `VITE_NAV_MODE` | Not established | Yes | `artifacts/dashboard/src/components/Sidebar.tsx:14` |
| `VITE_SUPABASE_ANON_KEY` | Yes | No | `artifacts/dashboard/src/lib/supabase.ts:8` |
| `VITE_SUPABASE_URL` | Yes | No | `artifacts/dashboard/src/lib/supabase.ts:7` |

## Latest job runs (14)

Each row is the latest record stored for that job; job history is not reconstructed from logs.
| Job | Last started (UTC) | Finished (UTC) | Duration | Status |
| --- | --- | --- | --- | --- |
| `compute_churn_scores` | 2026-09-30T20:45:38.463+00:00 | 2026-09-30T20:45:48.489+00:00 | 10.026 s | done |
| `compute_confidence` | 2026-05-07T14:31:32.515+00:00 | 2026-05-07T14:32:33.319+00:00 | 60.804 s | done |
| `confidence_nightly` | 2026-09-30T20:44:58.282+00:00 | 2026-09-30T20:45:37.393+00:00 | 39.111 s | done |
| `event_fill_sync` | — | — | Never run | idle |
| `import_dupr` | 2026-09-30T20:07:07.336+00:00 | 2026-09-30T20:07:07.521+00:00 | 0.185 s | error |
| `import_phones` | — | — | Never run | idle |
| `import_players` | 2026-09-30T20:15:40.503+00:00 | 2026-09-30T20:34:34.252+00:00 | 1133.749 s | done |
| `milestone_check` | 2026-07-31T23:48:42.273+00:00 | 2026-07-31T23:53:42.57+00:00 | 300.297 s | done |
| `monthly_recap` | — | — | Never run | idle |
| `nightly_sync` | 2026-09-30T20:15:40.282+00:00 | 2026-09-30T20:47:05.415+00:00 | 1885.133 s | done |
| `program_ratings` | — | — | Never run | idle |
| `programming_evaluate:c8976e15-e002-4619-bb4b-b1a70f5cd7ab` | 2026-09-30T21:23:03.42+00:00 | 2026-09-30T21:23:07.173+00:00 | 3.753 s | done |
| `sync_all` | 2026-04-29T01:32:47.094+00:00 | 2026-04-29T01:45:27.17+00:00 | 760.076 s | cancelled |
| `sync_events` | 2026-09-30T20:34:34.479+00:00 | 2026-09-30T20:44:58.091+00:00 | 623.612 s | done |

## Last 20 Git commits

| Commit | Time | Subject |
| --- | --- | --- |
| a141559 | 2026-09-30T20:59:48Z | Implement archived experiments and update program management logic |
| ee6ca44 | 2026-09-30T20:07:38Z | Implement incremental DUPR import and scheduler updates |
| 8ab8fe4 | 2026-08-12T14:50:37Z | Add experiment dashboard image and update tab layout |
| 09d9599 | 2026-08-11T21:38:00Z | Add contact ledger migration and update audit documentation |
| 9fa8117 | 2026-08-11T21:30:25Z | Block SMS dispatch until the operator has approved the audience: experiments send endpoint now checks the linked decision's approved_at (403 with clear message when unapproved, fails closed if the decision can't be verified), dry-run preconditions include audience_approved, and the queue detail view states dispatch is blocked until approval. |
| 18d3871 | 2026-08-11T21:30:14Z | Implement ledger audit and address silent failures in API routes |
| 0d6c837 | 2026-08-11T19:38:28Z | Task 15: Clinic promotion queue review UI with approve gate |
| dc5c364 | 2026-08-11T19:38:28Z | Git commit prior to merge |
| 247c0bc | 2026-08-11T16:44:07Z | Fix nightly sync crash-recovery: reclaim before running guard, reset heartbeat on startJob, heartbeat JOB_NIGHTLY between steps, guard event-sync step against concurrent manual sync |
| 7f766e3 | 2026-08-11T16:43:59Z | Refactor experiment route handlers and update memory notes |
| 5f543aa | 2026-08-11T16:26:24Z | Update dashboard experiments page and configure vite settings |
| e83e937 | 2026-08-11T16:19:49Z | Refactor Programs page and document experiment tab bug fix |
| 62afe52 | 2026-08-11T16:01:05Z | Update phase 4.1 send path report |
| 6efb8bf | 2026-08-11T15:16:28Z | Implement experiments feature backend routes and frontend dashboard tab |
| 282c1c9 | 2026-08-10T23:19:10Z | Implement experiment management routes and database schema |
| ee6e1e6 | 2026-08-10T21:59:03Z | Implement updates to programming route logic and dashboard view |
| a702a1a | 2026-08-10T21:35:18Z | Implement SMS consent functionality with migration and routing |
| c009920 | 2026-08-10T20:56:31Z | Implement cross-decision contact ledger mode for programming and dashboard views |
| c68a610 | 2026-08-07T00:41:49Z | Implement phase 3-4 contact ledger functionality and update memory documentation |
| 3782063 | 2026-08-05T23:53:47Z | Implement programming route and dashboard page updates |

## TODO / FIXME in src (3)

| File:line | Source |
| --- | --- |
| `artifacts/api-server/src/routes/onboarding.ts:28` | // Backward compat: Step 5 TODO — remove this branch once dashboard passes slug |
| `artifacts/api-server/src/routes/recap.ts:31` | const _clubId = (req as ClubScopedRequest).clubId; // TODO Step 7: pass to runMonthlyRecapBatch |
| `artifacts/api-server/src/routes/recap.ts:84` | const _clubId = (req as ClubScopedRequest).clubId; // TODO Step 7: pass to runMilestoneBatch |

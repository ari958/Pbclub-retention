Generated from live reads: 2026-09-30T21:37:18.289Z
# Retention audit — PB Club

## Scope, read-only verification, and definitions

- Club: **PB Club** (`pb-club`); timezone: **America/New_York**.
- Live data: 9,865 attendances, 2,820 players, 15 programs, 1,062 event_fill rows, and 1,311 buddy pairs.
- Methods: service-role Supabase SELECT/HEAD-equivalent metadata reads, source-file inspection, and PodPlay GET /coupons. No RPCs, inserts, updates, deletes, migrations, send endpoints, or Twilio calls were invoked for this audit.
- Only this report and temporary local analysis files were written. Existing application background workers were not started, stopped, or altered; this audit cannot make claims about unrelated worker activity.
- Findings come from current source and live reads, not saved memory. Database requests were read-only but not one transaction; generation timestamp identifies the extraction run.
- Stored attendance coverage: **2025-12-02 through 2026-09-30**. “First-ever” below means first-ever recorded in this database, not proof of the player's lifetime first visit.
- “Learn to Play graduate” is an analysis proxy: a distinct player with an accepted Learn to Play attendance row. There is no graduation/completion verification in the fields audited.
- A booking outcome uses the non-Learn-to-Play row's **booked_at**, not its attendance date. Upcoming bookings, canceled signups never imported, missing booking timestamps, and session no-shows are not fully observable here.

## Executive findings

- **attendances.attended_at is date, not timestamptz.** No checked-in migration converts it. Sending event.startTime in an upsert does not alter a PostgreSQL column type.
- **Attendance rows are not verified show-ups.** CONFIRMED and INVALID are accepted alongside CHECKED_IN; missing/empty signup statuses are also accepted.
- Strict Learn to Play identity finds **299 rows, 82 observed sessions, 262 distinct players**.
- Across the six reported first-recorded-date cohorts: **128 players**, observed subsequent bookings within 14 days **32/128 (25.0%)**, within 30 days **41/128 (32.0%)**. September is censored; same-day ordering and missing booking records limit these rates.
- At least one later-booking classmate: **193/262 (73.7%)**.
- Last-90-day Learn to Play proxy graduates: **63**, of whom **30** satisfy the audit's phone + opt-in + not-opted-out + web_form-source rule. This is not legal certification of marketing consent.
- **Unapproved automatic SMS paths exist.** The active queue poller can dispatch due scheduled rows without per-message approval; however, all 580 current pending rows have NULL schedules and none are currently eligible. Post-session feedback and inbound-feedback replies can also reach Twilio directly if live sending is enabled.
- **The kill switch is not global.** Only experiment dispatch checks it; those reads also fail open on database errors. Ordinary message sends are missing from contact_ledger.
- PodPlay GET /coupons returned **32 coupons**. Every returned coupon has active=true, but **11** have an endDate before extraction.
- Buddy notification permission: **1311 false, 0 true, 0 null**.

## 1. attended_at: actual type and migration evidence

Live service-role PostgREST OpenAPI reports attendances.attended_at as PostgreSQL format **date** (JSON type string). The table also has booked_at as timestamp with time zone. This is a live metadata check, not an inference from source or prior reports.

Searched all SQL under artifacts/api-server/migrations/, supabase/migrations/, and migrations/, plus the sync source for attended_at type changes. **No ALTER COLUMN attended_at TYPE timestamptz or equivalent conversion exists in the checked-in migrations.**
- supabase/migrations/20260506_booked_at.sql:1–3 adds **booked_at timestamptz**, not attended_at.
- supabase/migrations/20260506_warm_score.sql:13–15 adds attendance session_type, not a timestamp conversion.
- syncEventAttendance.js:375,401–412 assigns attended_at from **event.startTime**, and booked_at from **signup.summary.invitation.createdDate**. The upsert writes values, not DDL.
- artifacts/api-server/src/lib/playerTiming.ts:168–180,197–198 explicitly handles attended_at as date-only and synthesizes times.
- artifacts/api-server/package.json has no migration-runner script. Source-file existence is not evidence that SQL was applied.

**Why it is still date:** the checked-in database change needed to convert it was never implemented in these migration files. The sync passes timestamps into the existing date column, whose storage discards time-of-day. There is no checked-in automatic type-change path. I cannot establish whether an untracked manual conversion was intended, attempted, or reverted; no applied-migration ledger was available through this connection. In particular, there is no source evidence for claiming a specific timestamptz migration merely failed to run.

Timestamp recovery is incomplete: 6316/9865 attendance rows join event_fill by event_id; 210/299 Learn to Play rows have that join. Only 5203/6316 joined rows match the event's New York calendar date, and 5165/6316 match its UTC date. These discrepancies need investigation before substituting event_fill timestamps wholesale. This audit does not backfill or change either column.

## 2. Attendance semantics and source counts

The current sync does the following (artifacts/api-server/src/syncEventAttendance.js):
1. Keeps only events whose isCanceled is false and startTime is no later than now (:321–323).
2. Requires signup.owner.id and a matching local player (:387–395).
3. Uppercases signup.status; rejects a **nonempty** status outside ATTENDANCE_SIGNUP_STATUSES (:395–397).
4. ATTENDANCE_SIGNUP_STATUSES is **CONFIRMED, CHECKED_IN, INVALID** (src/lib/signupStatus.ts:57–61).
5. **Missing, null, or empty statuses pass the filter** because the rejection is guarded by signupStatus being truthy. PENDING, CANCELED, DRAFT, NO_SHOW, and any other nonempty status are not in the allowlist and are rejected.
6. Deduplicates per player/event, preferring CONFIRMED/CHECKED_IN over INVALID (:243–246,414–419), then performs batch dedup and ignore-duplicates upserts (:256–295).

**Canceled signups:** new CANCELED rows are not imported, and canceled events are not imported. However, the sync does not delete/reconcile an existing attendance when a signup or event is later canceled. ignoreDuplicates also prevents replacement of an earlier row. Thus the table may retain stale canceled bookings; this database does not store current signup status, so it cannot prove that none exist.
**No-shows:** an explicit nonempty NO_SHOW status would be rejected, but CONFIRMED is not a check-in. A no-show left CONFIRMED, INVALID, or without a status can be recorded. Therefore the table can include no-shows; their count cannot be determined from these rows alone.

### Live attendance row counts by source
| source | Rows |
| --- | --- |
| (null) | 2 |
| manual | 9863 |

Live metadata gives source default **manual**. The sync payload does **not** set source (:401–412), so imported rows inherit the misleading manual default. The 9863 “manual” rows therefore must not be interpreted as 9863 genuinely hand-entered attendances. All 9865 current attendance rows resolve to PB Club; the two-club inventory does not introduce a separate club's cohort here.

## 3. Learn to Play identification

### Proposed single matching rule
For the name field in each source: Unicode-normalize (NFKC), lowercase, replace hyphens/dashes/underscores with spaces, collapse whitespace, and match the whole-token phrase **learn to play** (`/\blearn to play\b/`). Use attendances.program_name, programs.name, and event_fill.event_name respectively. Do not infer Learn to Play from a generic Clinics type, beginner skill level, the word learn alone, or coupon redemption.
program_type is retained for the inventory but is not required: the catalog's actual Learn to Play row has program_type=NULL. This same rule is used for all cohort/classmate/eligibility numbers in this report.

### Every distinct strict match in live data
| Table | Actual name column / value | Actual type column / value | Count | Unit |
| --- | --- | --- | --- | --- |
| attendances | program_name: Learn to Play Clinic | program_type: Clinics | 299 | attendance rows |
| programs | name: Learn to Play | program_type: NULL | 1 | catalog rows |
| event_fill | event_name: Learn to Play Clinic | podplay_type: Clinics | 55 | events |

programs has **name**, not program_name. event_fill has **event_name / podplay_type**, not program_name / program_type. Counts above use the real columns rather than inventing aliases.

### Important classifier disagreement
The live programs row canonical_name='Learn to Play' has match_rules.keywords **['learn to play', 'path to advanced beginner']** and require_podplay_types=['Clinics']. Thus the current canonical classifier intentionally also refers to **Path to Advanced Beginner** as Learn to Play, even though the literal names differ.
**Path to Advanced Beginner appears in 39 attendance rows and 2 event_fill rows (type Clinics).** It is excluded from this audit's introductory Learn to Play cohort: it appears to be a progression class, not unambiguously a first-time introduction. Including it would change the cohort and make “booked another program” inconsistent when progression is mislabeled as the same program. This is a proposed audit rule only; no classifier was changed.

### Borderline / broad-match review inventory
These are all distinct live name/type pairs containing learn, intro, beginner, LTP, or first timer without the strict learn-to-play phrase. They are **not** automatically Learn to Play. Path to Advanced Beginner is the significant current-classifier alias; most other rows below are clear beginner/progression/social-play exclusions. No borderline raw programs.name match was found.
| Name | Type | Attendance rows | Program rows | event_fill events |
| --- | --- | --- | --- | --- |
|  Advanced Beginner Drilling / Open Play (2.75-3.00) | Open Play | 5 | 0 | 1 |
|  Advanced Beginner Open Play | Open Play | 29 | 0 | 5 |
|  Advanced Beginner Open Play (2.5-3.0) | Open Play | 82 | 0 | 14 |
|  Advanced Beginner Open Play (2.75-3.00) | Open Play | 44 | 0 | 8 |
|  Advanced Beginner Open Play (2.75-3.25) | Open Play | 36 | 0 | 5 |
|  Beginner Open Play | Open Play | 4 | 0 | 1 |
|  Beginner+ Open Play | Open Play | 0 | 0 | 1 |
| $$$ Cornhole Random Partner Tournament $$$ Beginner Friendly | Tournaments | 9 | 0 | 1 |
| $15 All Levels with Challenge Court and Beginner Court | Open Play | 11 | 0 | 0 |
| $16 Summer Advanced Beginner Open Play | Open Play | 6 | 0 | 1 |
| $16 Summer Advanced Beginner/ Low Intermediate Open Play | Open Play | 8 | 0 | 1 |
| $16 Summer Beginner Open Play | Open Play | 13 | 0 | 2 |
| $20 Beginner & Advanced Beginner Midday Open Play & Stay  | Open Play | 13 | 0 | 3 |
| 30 & 30 Beginner Drills & Guided Play | Clinics | 118 | 0 | 19 |
| Advanced Beginner 3 and Me: 60/60 Clinic with: Rob Gruber | Clinics | 3 | 0 | 0 |
| Advanced Beginner 3 and Me: Play With the Pro: Rob Gruber | Clinics | 16 | 0 | 5 |
| Advanced Beginner 60&60 Clinic | Clinics | 173 | 0 | 37 |
| Advanced Beginner Coach Led 60 & 60 | Clinics | 3 | 0 | 0 |
| Advanced Beginner Open Play (2.5-3.0) | Open Play | 14 | 0 | 0 |
| Advanced Beginner Open Play (2.75-3.00) | Open Play | 16 | 0 | 0 |
| Advanced Beginner/Beginner  60&60 Clinic | Clinics | 0 | 0 | 1 |
| Advanced Beginner/Beginner 60&60 Clinic | Clinics | 7 | 0 | 0 |
| Advanced Beginner+ 90 & 30 Soft Game Clinic | Clinics | 4 | 0 | 1 |
| Beginner 60&60 Clinic | Clinics | 158 | 0 | 35 |
| Beginner 60&60: Coach Led Drilling and Guided Play | Clinics | 4 | 0 | 1 |
| Beginner Coach Led 60 & 60 - Drill Session + Guided Play | Open Play | 19 | 0 | 2 |
| Beginner Play With the Pro: Rob Gruber | Clinics | 4 | 0 | 1 |
| Beginner/ Advanced Beginner Open Play Play with Pro: Rob Gruber | Clinics | 9 | 0 | 3 |
| Beginner+ 60&60 Clinic | Clinics | 1 | 0 | 1 |
| Beginner+ Open Play | Open Play | 7 | 0 | 1 |
| Coach Guided Beg - ADV Beginner+ Open Play | Open Play | 9 | 0 | 1 |
| Coach Guided Ladies Night w/ Challenge & Beginner Courts | Open Play | 29 | 0 | 3 |
| Coach Led $24 All Levels with Challenge Court and Beginner Court | Open Play | 5 | 0 | 0 |
| Coach Led Social Play with Challenge & Beginner Courts | Open Play | 18 | 0 | 1 |
| Instructional Advanced Beginner Open Play | Open Play | 9 | 0 | 2 |
| Instructional Advanced Beginner+ Open Play | Open Play | 5 | 0 | 1 |
| Instructional Beginner+ Open Play | Open Play | 105 | 0 | 10 |
| Learn Pro Patterns & Strategies - Guided Intermediate Open Play | Open Play | 8 | 0 | 1 |
| Learn Pro Patterns and Strategies - Guided Intermediate Open Play \| Challenge Court and Social Court | Open Play | 14 | 0 | 1 |
| Path to Advanced Beginner | Clinics | 39 | 0 | 2 |

## 4. Six-month baseline

### Calculation and caveats
- Six most recent calendar months: **April–September 2026**, including the current September month through 2026-09-30.
- For each player, find MIN(attended_at) across all their stored PB Club attendance history, not just Learn to Play rows. Include the player when at least one row on that earliest stored date matches the Learn to Play rule.
- A mixed first date (Learn to Play plus another program) has no provable within-day ordering. Such players are included in the main table but counted explicitly as ties; the conservative table excludes them.
- Subsequent booking = a nonmatching program row with a nonnull booked_at no later than extraction, whose New York booking calendar date is at or after the first stored attendance date and no more than 14 or 30 calendar days later. Same-day bookings are included; they might have been made before the class because attendance has no time-of-day.
- Each player is counted once per outcome window, regardless of number of bookings. Bookings made before the first attendance date are not counted as later conversions.
- **7149/9865 rows (72.5%) have booked_at; 2716 do not.** No attendance-date substitution is used for the booking metrics.
- These are **observed booking proxies**, not complete all-signup conversion rates or verified post-class retention. The sync only creates rows for past accepted-status events. Missing timestamps and omitted upcoming/canceled bookings may undercount; stale canceled rows, accepted no-shows, and same-day prebookings may overcount. The net bias is unknown.
- Mature-window rates use only players with at least the complete 14/30 calendar days of follow-up. A matured clock does not cure missing data. No completed September cohort has a full 30-day window yet.

### Main cohort and observed booking rates
| First recorded month | Players | Mixed first-date ties | Booked other ≤14d | Booked other ≤30d |
| --- | --- | --- | --- | --- |
| 2026-04 | 34 | 2 | 7/34 (20.6%) | 12/34 (35.3%) |
| 2026-05 | 26 | 1 | 4/26 (15.4%) | 6/26 (23.1%) |
| 2026-06 | 19 | 2 | 8/19 (42.1%) | 9/19 (47.4%) |
| 2026-07 | 17 | 1 | 3/17 (17.6%) | 4/17 (23.5%) |
| 2026-08 | 22 | 0 | 8/22 (36.4%) | 8/22 (36.4%) |
| 2026-09 | 10 | 0 | 2/10 (20.0%) | 2/10 (20.0%) |

### Complete follow-up denominators
| Month | 14d mature players / converted | 14d mature rate | 30d mature players / converted | 30d mature rate |
| --- | --- | --- | --- | --- |
| 2026-04 | 34 / 7 | 20.6% | 34 / 12 | 35.3% |
| 2026-05 | 26 / 4 | 15.4% | 26 / 6 | 23.1% |
| 2026-06 | 19 / 8 | 42.1% | 19 / 9 | 47.4% |
| 2026-07 | 17 / 3 | 17.6% | 17 / 4 | 23.5% |
| 2026-08 | 22 / 8 | 36.4% | 22 / 8 | 36.4% |
| 2026-09 | 4 / 1 | 25.0% | 0 / 0 | N/A |

### Conservative cohort: no non-Learn-to-Play row on the first date
| Month | Unambiguous first-date players | Booked other ≤14d | Booked other ≤30d |
| --- | --- | --- | --- |
| 2026-04 | 32 | 6/32 (18.8%) | 11/32 (34.4%) |
| 2026-05 | 25 | 4/25 (16.0%) | 6/25 (24.0%) |
| 2026-06 | 17 | 6/17 (35.3%) | 7/17 (41.2%) |
| 2026-07 | 16 | 2/16 (12.5%) | 3/16 (18.8%) |
| 2026-08 | 22 | 8/22 (36.4%) | 8/22 (36.4%) |
| 2026-09 | 10 | 2/10 (20.0%) | 2/10 (20.0%) |

### Top five programs booked next, by cohort
For comparability with the 30-day outcome, count each converted player's **earliest observed non-Learn-to-Play booking within 30 days** once. These are raw program names (not canonical buckets). Rank by count descending, alphabetical name as the tie-breaker; fewer than five are listed when fewer exist.
#### 2026-04
| Rank | Next program | Players |
| --- | --- | --- |
| 1 | Beginner 60&60 Clinic | 3 |
| 2 | Path to Advanced Beginner | 3 |
| 3 | 30 & 30 Beginner Drills & Guided Play | 2 |
| 4 | $20 3 Hour Late Night All Level Open Play | 1 |
| 5 | All You Can Play - All Levels with Challenge Court | 1 |

#### 2026-05
| Rank | Next program | Players |
| --- | --- | --- |
| 1 | 30 & 30 Beginner Drills & Guided Play | 2 |
| 2 | Beginner 60&60 Clinic | 2 |
| 3 | All Levels Open Play with Challenge Court | 1 |
| 4 | Play With the Pro: Rob Gruber | 1 |

#### 2026-06
| Rank | Next program | Players |
| --- | --- | --- |
| 1 | Beginner 60&60 Clinic | 2 |
| 2 | Path to Advanced Beginner | 2 |
| 3 | Summer $12 All Level Peak Open Play | 2 |
| 4 | $16 Summer Advanced Beginner/ Low Intermediate Open Play | 1 |
| 5 | Coach Led Social Play with Challenge & Beginner Courts | 1 |

#### 2026-07
| Rank | Next program | Players |
| --- | --- | --- |
| 1 | $16 Summer Beginner Open Play | 2 |
| 2 | Advanced Beginner 60&60 Clinic | 1 |
| 3 | Coach Led $24 All Levels with Challenge Court and Beginner Court | 1 |

#### 2026-08
| Rank | Next program | Players |
| --- | --- | --- |
| 1 | $15 All Levels with Challenge Court & Coach Led | 3 |
| 2 | Beginner 60&60 Clinic | 3 |
| 3 | $10 Summer Off-Peak All Levels Open Play | 1 |
| 4 | Advanced Beginner 60&60 Clinic | 1 |

#### 2026-09
| Rank | Next program | Players |
| --- | --- | --- |
| 1 | $15 All Levels with 2 Challenge Courts | 1 |
| 2 | Beginner/ Advanced Beginner Open Play Play with Pro: Rob Gruber | 1 |

## 5. Classmates

Session key = PodPlay event_id. For each strict-match Learn to Play event, count distinct player_id. A classmate is a **different player in the same event**, never the graduate themselves. All observed Learn to Play rows have an event_id, so no date/name fallback session was needed.
A later-booking classmate has a non-Learn-to-Play row with nonnull booked_at on a **strictly later New York calendar day** than the shared class and no later than extraction. This deliberately excludes same-day ambiguity. The horizon is any later observed booking, not a 30-day limit; they need not book the same next program or book together.

| Metric | Result |
| --- | --- |
| Observed Learn to Play sessions | 82 |
| Distinct player-session enrollments | 299 |
| Average per observed session | 3.65 |
| Median / min / max | 4 / 1 / 8 |
| Distinct proxy graduates | 262 |
| Graduates with at least one later-booking classmate | 193/262 (73.7%) |
| First-recorded-date Learn to Play subset with such a classmate | 172/231 (74.5%) |
| Observed sessions with such a classmate relationship | 65/82 (79.3%) |

Cross-check: event_fill has 55 strict-match Learn to Play events, none canceled and none without local matching rows, with 210 observed enrollments: 3.82 per event in that smaller cache. The headline 3.65 uses all 82 observed sessions, not only the event_fill subset.
Limitations: sessions absent from both data sets, including zero-participant sessions, are not in the full-history denominator. These are accepted signup-derived enrollments, not audited physical attendance. Classmate association is descriptive, not evidence that one person caused another to book.

## 6. Text eligibility and consent source

### Distinct source values
| Table / scope | consent_source | Count |
| --- | --- | --- |
| players / PB Club | (null) | 971 |
| players / PB Club | web_form | 1849 |
| sms_consent_records / all rows | web_form | 1895 |

The current runtime has **no marketing-valid consent_source allowlist**. The migration documents intended sources web_form / podplay / NULL but does not constrain them (artifacts/api-server/migrations/008_sms_consent.sql:3–7,53–58). Current consent import writes web_form to source records and matched players (src/routes/consent.ts:121–134,149–161); no current runtime writer sets podplay.
**Audit marketing-source rule:** accept only exact consent_source='web_form'; reject NULL, podplay, and unknown sources until appropriate affirmative marketing-consent evidence is established. This is a conservative provenance filter, not a legal determination that every imported form met all marketing-consent requirements. Current send paths do not enforce this source filter.

### Last 90-day lookback: 2026-07-02–2026-09-30
A graduate here means any distinct player with at least one Learn to Play row in this lookback, not necessarily a first-ever learner. Because attended_at is date-only, the boundary day is included in full; an exact rolling 90×24-hour cutoff cannot be recovered for every row.
| Predicate | Players |
| --- | --- |
| Learn to Play proxy graduates in lookback | 63 |
| Has a nonblank phone | 30 |
| sms_opt_in = true | 30 |
| opted_out = false (explicit false; NULL would fail closed) | 63 |
| consent_source = web_form | 30 |
| Phone AND sms_opt_in = true | 30 |
| Phone AND sms_opt_in AND opted_out = false | 30 |
| All four audit predicates | 30 |
| All-four group also has a matched web_form consent record | 30 |
| First-ever-recorded Learn to Play cohort in same lookback | 49 |
| First-ever-recorded subset satisfying all four predicates | 19 |

Among the 63 recent learners: 30 have web_form source and 33 have NULL; 30 are opted in and 33 are not. All are explicitly opted_out=false. A nonblank phone is not proof of a valid E.164 destination, delivery capability, or consent.
Important dispatch mismatch: ordinary single send, bulk, queue, and experiment dispatch recheck sms_opt_in and phone, **not opted_out** and not marketing consent_source. Feedback also uses opt-in/phone rather than opted_out. An opted_out=true / sms_opt_in=true disagreement is not independently blocked by these checks.

## 7. Current messages send path

### Status values: live rows versus source
| Live messages.status | Rows |
| --- | --- |
| pending | 580 |
| sent | 88 |
| skipped | 14 |

Live message status default is **pending**. All 682 rows in this read have direction=outbound.
Current code writes **pending, sent, skipped, failed**; the delivery webhook may also put **undelivered** in status when Twilio supplies it. No current messages status assignment uses draft, received, or error. Programming-notification and experiment statuses are separate schemas and must not be substituted for message statuses.
- pending: waiting/scheduled outbound row; agent generation relies on the database default, while recap/milestone/feedback/bulk inserts set pending explicitly.
- sent: helper returned successfully; **simulated=true rows are also marked sent**, so sent is not proof of delivery or even a Twilio API call. Inbound webhook rows, if created, are also assigned sent by source.
- skipped: explicit operator skip, opt-in/phone/cooldown rejection in applicable paths, or STOP canceling pending rows.
- failed: synchronous dispatch failure; webhook can later mark failed/undelivered. Other Twilio delivery states are recorded separately in delivery_status.
- There is no required draft→approved state transition for generic messages.

### Creation, draft editing, send, skip, and bulk
| Action / route | Effect and guards | Twilio / ledger |
| --- | --- | --- |
| Agent generation (src/routes/agent.ts:538–575) | Inserts outbound message with sent_at NULL and scheduled_send_at; relies on default pending. Returns message_id. It is not a send. | No immediate Twilio; no contact_ledger. Pending becomes queue-eligible. |
| Draft: PATCH /api/messages/:id/draft (messages.ts:682–725) | Edits an existing pending row's body, scoped to the club/player. Does not create a draft status, approve, or send. No POST /messages/draft exists. | No Twilio; no ledger. |
| Send: POST /api/messages/send (messages.ts:60–208) | Requires message_id, pending status, club ownership; checks opt-in, phone, 24-hour cooldown and template/body validity. Calls helper; sets sent_at, status=sent, SID, simulated and player last_outbound_at; dispatch errors mark failed. | Explicit operator API action; no kill-switch check and no contact_ledger. |
| Skip: POST /api/messages/skip (messages.ts:214–252) | Requires pending row owned by club; changes status to skipped. No send. | No Twilio; no ledger. |
| Bulk: POST /api/messages/bulk (messages.ts:254–410) | Requires nonempty player_ids and message_body, rejects unresolved variables, filters club/opt-in/phone, applies cooldown, interpolates per recipient, creates conversation/message pending then sends immediately and updates sent/SID/simulated; failures mark failed. Filtered/cooldown recipients get no skipped message row. | Explicit batch action, not a separate approval-state gate. No kill switch; no ledger. |

### Paths that can send without an explicit operator approval action
| Path | When it runs / preconditions | Approval gate? | contact_ledger? |
| --- | --- | --- | --- |
| Queue poller (src/lib/queuePoller.ts:29–149,159–180) | Requires pending AND scheduled_send_at NOT NULL AND scheduled_send_at <= now; limit 50. Uses America/New_York window: weekdays 08:00–19:30, weekends 08:30–19:30 inclusive (playerTiming.ts:398–409); rechecks opt-in/phone, no queue cooldown. Active startup invokes startQueuePoller (src/index.ts:103–114). Default interval five minutes. | No. Scheduled agent rows can bypass per-message approval when due; unscheduled pending rows cannot enter this poller. | No. |
| Post-session feedback (src/lib/postSessionFeedback.ts:180–257) | A live scheduler calls it every 30 minutes (src/lib/scheduler.ts:331–348); inserts pending then directly sends when Twilio credentials exist. Missing credentials leave pending rows without a source-populated schedule, so those rows are not queue-eligible by the shown source. | No per-message approval. No central kill-switch, cooldown, or TCPA-window check in the direct feedback path. | No. |
| Monthly recap / milestone (src/lib/monthlyRecap.ts:193–228; milestoneCheck.ts:189–235) | Nightly scheduler generates pending milestone rows and first-of-month recap rows (scheduler.ts:215–253), but these insert payloads omit scheduled_send_at. Manual batch routes also exist. | Automatic creation is not automatic sending here: no direct helper call, and NULL-scheduled rows are excluded by the queue. Operator send can dispatch them. | No ledger if later sent by the ordinary message route. |
| Inbound feedback retry / thanks (messages.ts:537–644) | Incoming feedback reply triggers direct helper calls and subsequent message bookkeeping. | No operator approval, consent refresh, central kill switch, cooldown, or send-window gate. | No. |
| Experiment dispatch (experiments.ts:1196–1500) | POST /api/experiments/:id/send requires approved=true, ready status, and linked-decision audience approval when applicable, plus event/level, audience, consent and capacity checks. | Yes, explicit dispatch approval; separate decision approval where required. | Yes for simulated=false sends only. |

**Live queue eligibility check (2026-09-30T21:42:38.870Z):** 580 pending rows have NULL scheduled_send_at; 0 pending rows have a schedule; 0 are due. Live OpenAPI shows no scheduled_send_at default. Current source only populates that field during agent generation, possibly with NULL. No checked-in filling trigger was found; live trigger definitions were not available through this connection.
Thus **yes, live Twilio can be reached without explicit approval**. Whether any particular call actually sends depends on the live flag and credentials; this audit did not inspect or disclose flag values and invoked none of these paths.

### Exact ordering of SMS_LIVE, SMS_TEST_OVERRIDE_TO, and sms_kill_switch
Shared helper src/lib/twilio.ts:26–82:
1. Reads SMS_LIVE and then SMS_TEST_OVERRIDE_TO (:30–31).
2. Computes effectiveTo = overrideTo || originalTo and applies/logs the override (:33–39).
3. Resolves sender/callback configuration, then checks !smsLive (:41–62); false-live returns SID=SIMULATED and simulated=true without calling Twilio.
4. If live, obtains the Twilio client and calls messages.create (:64–80); returns simulated=false (:82).
5. **sms_kill_switch is never checked in this helper.** It is also absent from generic single-send, bulk, queue, feedback and inbound-feedback callers.

Experiment dispatch adds its own preceding checks:
1. Request approval → ready state → linked-decision approval → event/level checks.
2. Reads SMS_TEST_OVERRIDE_TO, then SMS_LIVE; queries clubs.sms_kill_switch (:1275–1284). A non-dry-run request is blocked if the switch is true; a dry-run only reports the switch in its preconditions.
3. Loads/validates eligible treatment recipients; dry-run returns a preview before any helper call (:1287–1366).
4. For an actual send loop, rechecks sms_kill_switch per recipient (:1397–1405), then checks already-sent/opt-in/phone, then calls the shared helper, which applies override before its live/dry-run branch (:1417–1434).
5. Both batch and per-recipient switch queries ignore their Supabase error objects; missing/error data evaluates as switch-off. This is a **fail-open safety gap**, not a global stop.

**Override is not simulation:** when SMS_LIVE permits a send and an override is set, Twilio is called for the override phone but the helper returns simulated=false. Experiments then record the original participant/player in messages and contact_ledger. Test redirection can therefore consume the original player's ledger budget even though that player was not the actual recipient.

### contact_ledger, bookkeeping, and persistence risks
- Ordinary single, bulk, queue, feedback, recap/milestone, and inbound-feedback sends do not insert contact_ledger. Player last_outbound_at in some paths is not a substitute for a complete ledger.
- Experiment send writes messages **after** the Twilio call (:1434–1452), then inserts contact_ledger only if simulated=false (:1454–1465). Failures in post-send persistence cannot undo delivery; message/ledger coverage can therefore be incomplete.
- POST /api/experiments/:id/mark-sent is a separate bookkeeping action that can write sent metadata and ledger **without sending via Twilio** (:980–1055). A ledger entry alone is not independent proof of actual delivery.
- Generic single, bulk and queue correctly store helper.simulated, but set status=sent even for a dry-run.
- Feedback has a return-shape defect: it assigns the entire {sid, simulated} helper result to twilio_message_sid instead of the sid string (postSessionFeedback.ts:245–251), and does not persist simulated in that update. This may corrupt/fail bookkeeping after a send; no fix was applied.

## 8. Coupons

### Is signup.couponCode read?
**No.** Case-insensitive search of current runtime TS/JS in API and dashboard source found no couponCode, coupon_code, or coupon-code field read. Existing signup processing reads owner, status, and summary.invitation.createdDate but does not ingest or persist coupon usage. API documentation listing coupons is not runtime consumption.

### Current PodPlay coupon inventory (read-only GET)
Requested **GET /apis/v2/coupons?page=1&ipp=100** on the PB Club tenant using its existing x-api-key authentication. HTTP 200; 1 page; API total=32; received=32. This is the complete returned inventory, not just inferred coupon codes in source.
Value is the raw API value: PERCENT_OFF is a percentage; AMOUNT_OFF is reported without assuming currency units. All returned status fields are NULL and all active flags are true. Dates below are UTC timestamps; NULL means the API supplied no date bound. Expiration, user/event/domain restrictions, ticket limits and other eligibility rules still matter; active=true is not proof that a coupon is redeemable today.
| Code | Discount type | Raw value | Active | Start date (UTC) | End date (UTC) |
| --- | --- | --- | --- | --- | --- |
| LABORDAY26 | PERCENT_OFF | 35 | true | 2026-09-04T04:00:00.000Z | 2026-09-07T04:00:00.000Z |
| WELCOME | PERCENT_OFF | 100 | true | (null) | (null) |
| JULY4TH2026 | PERCENT_OFF | 50 | true | 2026-07-02T04:00:00.000Z | 2026-07-06T04:00:00.000Z |
| JPM50% | PERCENT_OFF | 50 | true | (null) | (null) |
| PBSPRING30% | PERCENT_OFF | 30 | true | 2026-05-25T04:00:00.000Z | 2026-06-08T04:00:00.000Z |
| PBCLUBWELCOME | PERCENT_OFF | 100 | true | (null) | (null) |
| WOMEN25 | PERCENT_OFF | 25 | true | (null) | 2026-05-01T04:00:00.000Z |
| FIRST40 | PERCENT_OFF | 40 | true | (null) | (null) |
| WELCOME30 | PERCENT_OFF | 30 | true | (null) | (null) |
| FLASHNOW35% | PERCENT_OFF | 35 | true | (null) | 2026-03-30T04:00:00.000Z |
| 10%JANUARY25 | PERCENT_OFF | 10 | true | (null) | 2026-02-01T05:00:00.000Z |
| 1STLEAGUE10% | PERCENT_OFF | 10 | true | (null) | (null) |
| 2025XMAS30% | PERCENT_OFF | 30 | true | (null) | 2025-12-31T05:00:00.000Z |
| 20%BOSSNANCY | PERCENT_OFF | 20 | true | (null) | (null) |
| ADMINDISCOUNT | PERCENT_OFF | 20 | true | (null) | (null) |
| AJF50%OP | PERCENT_OFF | 50 | true | (null) | (null) |
| BLACKFRIDAY50% | PERCENT_OFF | 50 | true | (null) | 2025-12-10T05:00:00.000Z |
| FIRST25 | PERCENT_OFF | 25 | true | (null) | (null) |
| JEFFS10 | PERCENT_OFF | 10 | true | (null) | (null) |
| LAYUPS4LIFE | AMOUNT_OFF | 100 | true | (null) | (null) |
| LEARNPICKLE25% | PERCENT_OFF | 25 | true | (null) | (null) |
| NEWCOURT25% | PERCENT_OFF | 25 | true | (null) | (null) |
| PBCLINIC1 | PERCENT_OFF | 20 | true | (null) | (null) |
| PBCLINIC2 | PERCENT_OFF | 30 | true | (null) | (null) |
| PBCR1 | PERCENT_OFF | 20 | true | (null) | (null) |
| PBCR2 | PERCENT_OFF | 30 | true | (null) | (null) |
| PBOP1 | PERCENT_OFF | 20 | true | (null) | (null) |
| PBOP2 | PERCENT_OFF | 30 | true | (null) | (null) |
| PRIVATECOURT40% | PERCENT_OFF | 40 | true | (null) | 2025-12-09T05:00:00.000Z |
| REDDIT25 | PERCENT_OFF | 25 | true | (null) | (null) |
| SAT3RD | AMOUNT_OFF | 5 | true | (null) | 2026-01-04T05:00:00.000Z |
| SNOW50 | PERCENT_OFF | 50 | true | (null) | 2026-02-24T05:00:00.000Z |

No eligible-user lists, customer redemption identities, API credentials, or environment values are included.

## 9. Buddy notification flag

| buddy_pairs.opt_in_notifications | Rows | Share |
| --- | --- | --- |
| true | 0 | 0.0% |
| false | 1311 | 100.0% |
| NULL | 0 | 0.0% |

buddy_pairs has no club_id; this is a table-wide distribution, not a fabricated club-filtered result. The classmate calculations use attendance co-enrollment, not this flag. A buddy relationship does not establish permission to send buddy notifications; the current stored flags grant no such permission.

## Recommended follow-up investigations — not executed

1. Reconcile original event timestamps and signup/check-in/cancellation history before claiming verified graduation or exact post-class conversion. Establish an explicit source/status provenance model instead of defaulting PodPlay rows to manual.
2. Keep Path to Advanced Beginner distinct from true introductory Learn to Play unless the business intentionally defines a combined cohort.
3. Obtain all-booking history (including upcoming and canceled bookings), reliably preserve booked_at, and recompute complete follow-up cohorts with consistent timezones.
4. Enforce explicit approval before any marketing dispatch, a global fail-closed kill switch, and consent/opt-out checks across all send paths; unify ledger accounting and distinguish redirected test delivery from contacting the original participant.
5. Validate the actual web-form marketing-consent evidence and buddy permissions before designing any retention campaign.
These are findings and proposals only. **No data changes, migrations, or SMS sends were performed by this audit.**

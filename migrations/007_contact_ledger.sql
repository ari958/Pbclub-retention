-- Phase 3.4 — Cross-Decision Contact Ledger
-- Run in Supabase: SQL editor → paste → Run
--
-- Purpose: single source of truth for all promotional and transactional
-- contacts sent by the programming agent (and, later, Pulse).  Budget logic
-- reads from this table; messages/conversations are NOT the source of truth
-- for contact budgets.
--
-- Cancellation notices are EXEMPT from budget checks — a member whose session
-- was cancelled must be notified regardless of promotional history.  They are
-- still recorded here (purpose='cancellation') so the operator can see the
-- full contact picture.

create table if not exists public.contact_ledger (
  id          uuid primary key default gen_random_uuid(),
  club_id     uuid not null references public.clubs(id) on delete cascade,
  player_id   uuid not null references public.players(id) on delete cascade,

  -- Source allows Pulse or other systems to write entries later without a schema change.
  source      text not null default 'programming',   -- 'programming' | future values

  -- Purpose drives budget logic.  Cancellation is ALWAYS exempt from budget gates
  -- (see contact_budget.applies_to — it must never include 'cancellation').
  purpose     text not null check (purpose in ('promotion','cancellation','other')),

  channel     text not null check (channel in ('sms','email')),

  -- Optional link back to the decision that triggered this contact.
  decision_id uuid references public.programming_decisions(id) on delete set null,

  sent_at     timestamptz not null default now(),

  -- Filled in later when the outcome is known.
  outcome     text check (outcome in ('booked','opted_out','no_response')),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Hot query: "what promotional contacts has this player received recently?"
-- Used by the budget gate on every candidate build.
create index if not exists contact_ledger_club_player_sent
  on public.contact_ledger(club_id, player_id, sent_at desc);

-- Secondary index for club-level analytics (total sends, distinct players, 30d window).
create index if not exists contact_ledger_club_sent
  on public.contact_ledger(club_id, sent_at desc)
  where purpose = 'promotion';

-- contact_budget column on programming_rules so operators can tune
-- cooldown_days and max_per_30_days without a code change.
-- Default matches the Phase 3.4 spec: 7-day cooldown, max 2 per 30 days.
alter table public.programming_rules
  add column if not exists contact_budget jsonb
  default '{"cooldown_days":7,"max_per_30_days":2,"applies_to":["promotion"]}';

-- Row-level security
alter table public.contact_ledger enable row level security;

create policy "service_role_all" on public.contact_ledger
  for all to service_role using (true) with check (true);

create policy "authenticated_read" on public.contact_ledger
  for select to authenticated
  using (true);

grant select, insert, update on public.contact_ledger to authenticated;
grant all on public.contact_ledger to service_role;

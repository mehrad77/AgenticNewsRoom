-- migrate:up
-- Milestone 3: the desk's tools, the verifier gate and budgets (docs/technical-design.md#agent-runs,
-- #verifier-gate).

-- Created per database by anr-roles (extensions need a superuser); here only as a guard.
create extension if not exists pg_trgm;

-- The search_leads tool: trigram word similarity over normalised headline, summary and text.
-- Queries must use this exact expression for the index to apply.
create index leads_search_trgm_idx on leads using gin (
  anr.normalize_text(coalesce(headline, '') || ' ' || coalesce(summary, '') || ' ' || body, language)
  gin_trgm_ops
);

-- A stored lead later found withdrawn or retracted (issue #3). Its text stays frozen and claims
-- citing it stay readable, but assignments and search skip it and the verifier fails any claim
-- that cites it (D78).
alter table leads
  add column withdrawn_at timestamptz,
  add column withdrawn_reason text,
  add constraint leads_withdrawn_reason check ((withdrawn_at is null) = (withdrawn_reason is null));

-- Every model family that answered in a run: a run that fell back mid-way wrote with several,
-- and the fact-checker must avoid all of them (D71). Tokens and cost are summed over its calls.
alter table agent_runs
  add column families text[] not null default '{}',
  -- The rendition language a renderer run writes.
  add column language text check (language in ('fa', 'en', 'tr')),
  -- Why a run ended without a submit: validation errors, a token cap, a paused budget.
  add column detail jsonb;
alter table agent_runs drop constraint agent_runs_outcome_check;
alter table agent_runs add constraint agent_runs_outcome_check
  check (outcome in ('submitted', 'invalid', 'error', 'timed-out', 'paused'));

-- The beat the desk placed the story in; a publication carries its beat's Media Topics (D41).
-- `not valid`: validating existing rows would scan stories under forced RLS outside any newsroom
-- (D48); the column is new, so every existing row is null anyway.
alter table stories
  add column beat_id uuid,
  add constraint stories_beat_fkey
    foreign key (newsroom_id, beat_id) references beats (newsroom_id, id) not valid;

-- A claim's id inside its story's submit (c1, c2, ...): rendition items list these, so a stored
-- rendition body stays valid against its format schema.
alter table claims
  add column ref text check (ref ~ '^c[0-9]+$'),
  add constraint claims_story_ref_key unique (newsroom_id, story_id, ref);

-- Corroboration: further leads and passages that support the same claim (D74). Independence is
-- counted over the claim's lead and these, by publisher, after deduplication.
create table claim_sources (
  newsroom_id uuid not null references newsrooms (id),
  claim_id uuid not null,
  position smallint not null check (position >= 1),
  lead_id uuid not null,
  quoted_passage text not null,
  primary key (claim_id, position),
  foreign key (newsroom_id, claim_id) references claims (newsroom_id, id) on delete cascade,
  foreign key (newsroom_id, lead_id) references leads (newsroom_id, id)
);
create index claim_sources_newsroom_idx on claim_sources (newsroom_id, lead_id);
alter table claim_sources enable row level security;
alter table claim_sources force row level security;
create policy claim_sources_tenant on claim_sources
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on claim_sources to anr_app, anr_system;

-- One rendition per story, format and language: a retried submit cannot add a second.
alter table renditions
  add constraint renditions_story_format_language_key unique (newsroom_id, story_id, format_id, language);

-- Messages to a newsroom's Editor-in-Chief from code, shown in the editor's desk: a budget at 80%
-- or at its cap, a slot with no leads. `key` makes each one once per period (a month, a slot).
create table notices (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  kind text not null check (kind in ('budget-warning', 'budget-cap', 'no-leads')),
  key text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (newsroom_id, kind, key),
  unique (newsroom_id, id)
);
alter table notices enable row level security;
alter table notices force row level security;
create policy notices_tenant on notices
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on notices to anr_app, anr_system;

-- migrate:down
drop table notices;
alter table renditions drop constraint renditions_story_format_language_key;
drop table claim_sources;
alter table claims drop constraint claims_story_ref_key, drop column ref;
alter table stories drop constraint stories_beat_fkey, drop column beat_id;
alter table agent_runs drop constraint agent_runs_outcome_check;
alter table agent_runs add constraint agent_runs_outcome_check
  check (outcome in ('submitted', 'invalid', 'error', 'timed-out'));
alter table agent_runs drop column detail, drop column language, drop column families;
alter table leads drop constraint leads_withdrawn_reason, drop column withdrawn_reason,
  drop column withdrawn_at;
drop index leads_search_trgm_idx;

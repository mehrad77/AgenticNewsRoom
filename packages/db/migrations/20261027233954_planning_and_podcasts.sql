-- migrate:up
-- Planning and podcasts (milestone 5): planner runs and what they propose, the weekly pick's
-- deadline, episode stories built from other stories' claims, finished episode audio, and the
-- download counter's 24-hour deduplication.

-- What a run without an assignment works on (the planner's themes or candidates, an episode's
-- voices). `key` names it, so a second tick never starts the same planner work twice; a run that
-- failed may be followed by another.
alter table agent_runs add column task jsonb;
create unique index agent_runs_planner_task_key on agent_runs (newsroom_id, (task->>'key'))
  where role = 'planner' and (outcome is null or outcome = 'submitted');
-- TTS is code, not an agent, but each of its calls is priced and counted like one (D76).
alter table agent_runs drop constraint agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('planner', 'desk', 'renderer', 'fact-checker', 'item-matcher', 'summariser', 'tts'));

-- A proposed theme keeps the leads and reasoning behind it; the Editor-in-Chief's decision is audited.
alter table editorial_cycles
  add column rationale text,
  add column lead_ids uuid[] not null default '{}',
  add column agent_run_id uuid,
  add column decided_by uuid references users (id),
  add column decided_at timestamptz,
  add constraint editorial_cycles_decided_check
    check ((status = 'proposed') = (decided_at is null)),
  -- Not valid: validating would scan existing rows under forced RLS; the new column is empty.
  add constraint editorial_cycles_run_fkey
    foreign key (newsroom_id, agent_run_id) references agent_runs (newsroom_id, id) not valid;
create index editorial_cycles_starts_idx on editorial_cycles (newsroom_id, starts);

-- The slot a pick is for; a pick is chosen or skipped at its deadline, never both.
alter table picks
  add column slot timestamptz not null,
  add column agent_run_id uuid,
  add column picked_at timestamptz,
  add column skipped_at timestamptz,
  add constraint picks_picked_check check ((chosen is null) = (picked_at is null)),
  add constraint picks_decided_check check (picked_at is null or skipped_at is null),
  add constraint picks_run_fkey
    foreign key (newsroom_id, agent_run_id) references agent_runs (newsroom_id, id) not valid;

-- An episode's story holds copies of its source stories' claims; this names the original.
alter table claims
  add column copied_from uuid,
  add constraint claims_copied_from_fkey
    foreign key (newsroom_id, copied_from) references claims (newsroom_id, id) not valid;

alter table notices drop constraint notices_kind_check;
alter table notices add constraint notices_kind_check
  check (kind in ('budget-warning', 'budget-cap', 'no-leads', 'no-channel', 'no-theme',
                  'pick-missed', 'plan-failed'));

-- Finished audio of a podcast publication, one per script version: mixed, tagged, signed and
-- stored. Failures hold the publication instead of writing a row.
create table episodes (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  publication_id uuid not null,
  rendition_id uuid not null,
  script_hash text not null,
  media_key text not null,
  bytes bigint not null check (bytes > 0),
  seconds numeric(8, 2) not null check (seconds > 0),
  chapters jsonb not null default '[]',
  digital_source_type text not null,
  signed boolean not null,
  created_at timestamptz not null default now(),
  unique (newsroom_id, id),
  unique (publication_id, script_hash),
  foreign key (newsroom_id, publication_id) references publications (newsroom_id, id),
  foreign key (newsroom_id, rendition_id) references renditions (newsroom_id, id)
);
alter table episodes enable row level security;
alter table episodes force row level security;
create policy episodes_tenant on episodes
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on episodes to anr_app, anr_system;

-- One row per listener and day for each episode (D27): `key` is an HMAC of address and user agent
-- under a secret derived for that day, so it cannot be reversed or matched across days. Rows
-- older than yesterday are deleted as new ones come in.
create table download_keys (
  newsroom_id uuid not null references newsrooms (id),
  publication_id uuid not null,
  day date not null,
  key bytea not null,
  primary key (publication_id, day, key),
  foreign key (newsroom_id, publication_id) references publications (newsroom_id, id)
);
create index download_keys_day_idx on download_keys (newsroom_id, day);
alter table download_keys enable row level security;
alter table download_keys force row level security;
create policy download_keys_tenant on download_keys
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on download_keys to anr_app, anr_system;

-- migrate:down
drop table download_keys;
drop table episodes;
alter table notices drop constraint notices_kind_check;
alter table notices add constraint notices_kind_check
  check (kind in ('budget-warning', 'budget-cap', 'no-leads', 'no-channel'));
alter table claims drop constraint claims_copied_from_fkey, drop column copied_from;
alter table picks drop constraint picks_run_fkey, drop constraint picks_decided_check,
  drop constraint picks_picked_check, drop column skipped_at, drop column picked_at,
  drop column agent_run_id, drop column slot;
drop index editorial_cycles_starts_idx;
alter table editorial_cycles drop constraint editorial_cycles_run_fkey,
  drop constraint editorial_cycles_decided_check, drop column decided_at, drop column decided_by,
  drop column agent_run_id, drop column lead_ids, drop column rationale;
alter table agent_runs drop constraint agent_runs_role_check;
alter table agent_runs add constraint agent_runs_role_check
  check (role in ('planner', 'desk', 'renderer', 'fact-checker', 'item-matcher', 'summariser'));
drop index agent_runs_planner_task_key;
alter table agent_runs drop column task;

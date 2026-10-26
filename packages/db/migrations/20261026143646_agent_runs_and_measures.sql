-- migrate:up
-- Every model call, with its cost (docs/technical-design.md#agent-runs). The router reads the
-- story's desk run to pick a fact-checker model that did not write it.
create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  role text not null
    check (role in ('planner', 'desk', 'renderer', 'fact-checker', 'item-matcher', 'summariser')),
  provider text not null,
  model text not null,
  prompt_version text not null,
  input_hash text not null,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(12, 6),
  -- Empty while running.
  outcome text check (outcome in ('submitted', 'invalid', 'error', 'timed-out')),
  assignment_id uuid,
  story_id uuid,
  lead_id uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (newsroom_id, id),
  foreign key (newsroom_id, assignment_id) references assignments (newsroom_id, id),
  foreign key (newsroom_id, story_id) references stories (newsroom_id, id),
  foreign key (newsroom_id, lead_id) references leads (newsroom_id, id)
);
create index agent_runs_started_idx on agent_runs (newsroom_id, started_at);
create index agent_runs_story_idx on agent_runs (newsroom_id, story_id);
alter table agent_runs enable row level security;
alter table agent_runs force row level security;
create policy agent_runs_tenant on agent_runs
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on agent_runs to anr_app, anr_system;

-- Audience counters per day (docs/technical-design.md#measures).
create table page_views (
  newsroom_id uuid not null references newsrooms (id),
  publication_id uuid not null,
  day date not null,
  count integer not null default 0 check (count >= 0),
  primary key (publication_id, day),
  foreign key (newsroom_id, publication_id) references publications (newsroom_id, id)
);
alter table page_views enable row level security;
alter table page_views force row level security;
create policy page_views_tenant on page_views
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on page_views to anr_app, anr_system;

create table downloads (
  newsroom_id uuid not null references newsrooms (id),
  publication_id uuid not null,
  day date not null,
  count integer not null default 0 check (count >= 0),
  primary key (publication_id, day),
  foreign key (newsroom_id, publication_id) references publications (newsroom_id, id)
);
alter table downloads enable row level security;
alter table downloads force row level security;
create policy downloads_tenant on downloads
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on downloads to anr_app, anr_system;

create table channel_stats (
  newsroom_id uuid not null references newsrooms (id),
  channel_id uuid not null,
  day date not null,
  subscribers integer not null check (subscribers >= 0),
  primary key (channel_id, day),
  foreign key (newsroom_id, channel_id) references channels (newsroom_id, id)
);
alter table channel_stats enable row level security;
alter table channel_stats force row level security;
create policy channel_stats_tenant on channel_stats
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on channel_stats to anr_app, anr_system;

-- migrate:down
drop table channel_stats;
drop table downloads;
drop table page_views;
drop table agent_runs;

-- migrate:up

-- A run of the check of imported news (D184), started and stopped from the desk. The agents worker
-- works it round by round, a few stories at a time, until nothing is left to do, it is asked to
-- stop, or something it needs is down; `heartbeat_at` tells a live run from one a restart cut off.
create table recheck_runs (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  started_by uuid references users (id),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  stop_requested_at timestamptz,
  finished_at timestamptz,
  -- done: nothing left to do; stopped: a person asked; blocked: models or ingestion unavailable,
  -- no item's try spent; failed: an error the run could not get past.
  outcome text check (outcome in ('done', 'stopped', 'blocked', 'failed')),
  detail text,
  rounds integer not null default 0,
  sourced integer not null default 0,
  checked integer not null default 0,
  unique (newsroom_id, id),
  check ((finished_at is null) = (outcome is null))
);
-- One open run per newsroom.
create unique index recheck_runs_open on recheck_runs (newsroom_id) where finished_at is null;
alter table recheck_runs enable row level security;
alter table recheck_runs force row level security;
create policy recheck_runs_tenant on recheck_runs
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on recheck_runs to anr_app, anr_system;

-- migrate:down
drop table recheck_runs;

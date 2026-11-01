-- migrate:up
-- Milestone 7a: dry runs (D126), missed slots (D129), heartbeats and outages (D128), backup runs
-- (D131) and the platform admin's Ops controls (D144). Every added column has a default, so the
-- previous release still runs on this schema (D134).

-- A send recorded instead of made, where ANR_PUBLISH is not `live` (D126).
alter table posts add column dry_run boolean not null default false;

-- How late a send may still start, from each format's format.yaml (D129); config sync sets it.
alter table formats add column grace interval not null default interval '30 minutes'
  check (grace > interval '0');

-- A slot that went by unsent: held past its grace, or never assigned (D129, D130).
alter table notices drop constraint notices_kind_check;
alter table notices add constraint notices_kind_check
  check (kind in ('budget-warning', 'budget-cap', 'no-leads', 'no-channel', 'no-theme',
                  'pick-missed', 'plan-failed', 'challenge-due', 'challenge-overdue',
                  'media-failed', 'slot-missed'));

-- Each worker's last beat, by Postgres's clock (D128).
create table heartbeats (
  worker text primary key check (worker ~ '^[a-z][a-z0-9-]*$'),
  beat_at timestamptz not null
);
grant select, insert, update on heartbeats to anr_app, anr_system;

-- A gap of more than 3 minutes between beats: one worker's, or the whole host's (D128).
create table outages (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('worker', 'host')),
  worker text check ((kind = 'worker') = (worker is not null)),
  started_at timestamptz not null,
  ended_at timestamptz not null check (ended_at > started_at)
);
create index outages_started_at_idx on outages (started_at);
grant select, insert on outages to anr_app, anr_system;

-- One worker's beat. A beat more than 3 minutes after the worker's previous one closes a gap: when
-- every worker was silent through it, the host was down or asleep and the first beat back records
-- one host outage; otherwise this worker was, unless a host outage already covers its gap.
create function anr.beat(p_worker text, p_at timestamptz default now()) returns text
language plpgsql
as $$
declare
  previous timestamptz;
  latest timestamptz;
  recorded text;
begin
  -- One beat at a time, so workers waking together record the host's outage once.
  perform pg_advisory_xact_lock(hashtextextended('anr.beat', 0));
  select beat_at into previous from heartbeats where worker = p_worker;
  if previous is not null and p_at - previous > interval '3 minutes' then
    select max(beat_at) into latest from heartbeats;
    if latest <= p_at - interval '3 minutes' then
      insert into outages (kind, started_at, ended_at) values ('host', latest, p_at);
      recorded := 'host';
    elsif not exists (select from outages
                      where kind = 'host' and started_at < p_at and ended_at > previous) then
      insert into outages (kind, worker, started_at, ended_at)
        values ('worker', p_worker, previous, p_at);
      recorded := 'worker';
    end if;
  end if;
  insert into heartbeats (worker, beat_at) values (p_worker, p_at)
    on conflict (worker) do update set beat_at = excluded.beat_at;
  return recorded;
end;
$$;
grant execute on function anr.beat(text, timestamptz) to anr_app, anr_system;

-- A backup check or a run the desk asked for (D144), picked up by the host's one-minute job.
create table ops_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('backup-check')),
  requested_by uuid not null references users (id),
  requested_at timestamptz not null default now(),
  picked_at timestamptz,
  done_at timestamptz
);
create index ops_requests_pending_idx on ops_requests (requested_at) where picked_at is null;
grant select, insert on ops_requests to anr_app;
grant select on ops_requests to anr_system;

-- Every run of infra/backup/backup.sh, written by the script as the superuser (D131).
create table backup_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('init', 'full', 'diff', 'incr', 'check')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  detail text,
  request_id uuid references ops_requests (id),
  check ((finished_at is null) = (ok is null))
);
create index backup_runs_started_at_idx on backup_runs (started_at);
grant select on backup_runs to anr_app, anr_system;

-- A queue workers take no new job from (D144). Only queues whose work ends in a hold or is done
-- again on the next run; never a deadline, a correction, an assignment, a redraft or the sweep.
create table queue_drains (
  queue text primary key check (queue in ('ingest-source', 'ingest-media', 'agent-run', 'gate',
                                          'podcast-audio', 'plan', 'channel-check',
                                          'channel-stats')),
  drained_by uuid not null references users (id),
  drained_at timestamptz not null default now()
);
grant select, insert, delete on queue_drains to anr_app;
grant select on queue_drains to anr_system;

-- One newsroom's publishing paused by the platform admin (D144); resuming deletes the row. The
-- pause of every newsroom at once is the platform setting `publishing.paused`.
create table publishing_pauses (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null unique references newsrooms (id),
  paused_by uuid not null references users (id),
  paused_at timestamptz not null default now(),
  unique (newsroom_id, id)
);
alter table publishing_pauses enable row level security;
alter table publishing_pauses force row level security;
create policy publishing_pauses_tenant on publishing_pauses
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, delete on publishing_pauses to anr_app, anr_system;

-- migrate:down
drop table publishing_pauses;
drop table queue_drains;
drop table backup_runs;
drop table ops_requests;
drop function anr.beat(text, timestamptz);
drop table outages;
drop table heartbeats;
alter table notices drop constraint notices_kind_check;
alter table notices add constraint notices_kind_check
  check (kind in ('budget-warning', 'budget-cap', 'no-leads', 'no-channel', 'no-theme',
                  'pick-missed', 'plan-failed', 'challenge-due', 'challenge-overdue',
                  'media-failed'));
alter table formats drop column grace;
alter table posts drop column dry_run;

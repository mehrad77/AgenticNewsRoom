-- migrate:up
-- Every URL an agent run asked ingestion to fetch, logged before the fetch: the per-run cap
-- (D61) counts these, so a request that ends as a copy, a known lead or no text still counts.
create table source_requests (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  agent_run_id uuid not null,
  uri text not null,
  requested_at timestamptz not null default now(),
  unique (newsroom_id, id),
  foreign key (newsroom_id, agent_run_id) references agent_runs (newsroom_id, id)
);
create index source_requests_run_idx on source_requests (newsroom_id, agent_run_id);
alter table source_requests enable row level security;
alter table source_requests force row level security;
create policy source_requests_tenant on source_requests
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on source_requests to anr_app, anr_system;

-- migrate:down
drop table source_requests;

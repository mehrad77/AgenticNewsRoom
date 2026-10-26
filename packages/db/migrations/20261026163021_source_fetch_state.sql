-- migrate:up
-- Ingestion's own state per source, kept apart from the config-synced `sources` row: the
-- validators for conditional GET and the outcome of the last fetch.
create table source_fetch_state (
  newsroom_id uuid not null references newsrooms (id),
  source_id uuid primary key,
  etag text,
  last_modified text,
  last_fetched_at timestamptz,
  -- HTTP status of the last fetch; empty when it failed before a response.
  last_status smallint,
  last_error text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  foreign key (newsroom_id, source_id) references sources (newsroom_id, id)
);
create index source_fetch_state_newsroom_idx on source_fetch_state (newsroom_id);
alter table source_fetch_state enable row level security;
alter table source_fetch_state force row level security;
create policy source_fetch_state_tenant on source_fetch_state
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on source_fetch_state to anr_app, anr_system;

-- migrate:down
drop table source_fetch_state;

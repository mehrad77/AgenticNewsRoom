-- migrate:up
-- What ingestion keeps with each lead beyond milestone 1's columns.
alter table leads
  -- Object-store key of the raw page as fetched (content-addressed, sha256 of the bytes).
  add column raw_key text,
  -- 64-bit SimHash of the stored text, for near-duplicate detection (D56).
  add column simhash bigint,
  -- ninjs `links`: related URLs, e.g. the page a Hacker News item points to.
  add column links jsonb not null default '[]' check (jsonb_typeof(links) = 'array'),
  -- The agent run that requested this lead through ingestion; empty for scheduled fetches.
  add column requested_by_run uuid,
  -- `not valid`: checking existing rows would scan leads under forced RLS outside any newsroom,
  -- which raises (D48). The column is new, so every existing row is null and passes anyway; new
  -- and updated rows are checked as usual.
  add constraint leads_requested_by_run_fkey
    foreign key (newsroom_id, requested_by_run) references agent_runs (newsroom_id, id) not valid;
create index leads_fetched_idx on leads (newsroom_id, fetched_at);
create index leads_requested_by_run_idx on leads (newsroom_id, requested_by_run)
  where requested_by_run is not null;

-- The snapshot is the raw page and the text derived from it; neither changes once written.
create or replace function anr.forbid_lead_text_change() returns trigger
language plpgsql
as $$
begin
  if new.body is distinct from old.body
     or new.content_hash is distinct from old.content_hash
     or new.simhash is distinct from old.simhash
     or new.raw_key is distinct from old.raw_key then
    raise exception 'a lead''s stored text is frozen (lead %)', old.id;
  end if;
  return new;
end;
$$;

-- migrate:down
create or replace function anr.forbid_lead_text_change() returns trigger
language plpgsql
as $$
begin
  if new.body is distinct from old.body or new.content_hash is distinct from old.content_hash then
    raise exception 'a lead''s stored text is frozen (lead %)', old.id;
  end if;
  return new;
end;
$$;
drop index leads_requested_by_run_idx;
drop index leads_fetched_idx;
alter table leads
  drop constraint leads_requested_by_run_fkey,
  drop column requested_by_run,
  drop column links,
  drop column simhash,
  drop column raw_key;

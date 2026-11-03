-- migrate:up

-- A newsroom's Reference kinds are its configuration (D170): reference.yaml, synced here. Entries
-- take any kind that matches a slug; the importer and the site accept only the kinds configured.
alter table newsrooms add column reference jsonb not null default '{}';
alter table reference_entries drop constraint reference_entries_kind_check;
alter table reference_entries
  add constraint reference_entries_kind_check check (kind ~ '^[a-z][a-z0-9-]*$');

-- How entries point at each other (D162): a news event made by an organisation, a paper written by
-- a person. `label` keeps the name as the source wrote it, so the page links that very name.
create table reference_entry_links (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  from_entry uuid not null,
  to_entry uuid not null,
  kind text not null,
  label text not null,
  created_at timestamptz not null default now(),
  unique (newsroom_id, id),
  unique (newsroom_id, from_entry, to_entry, kind, label),
  -- Composite: foreign-key checks bypass RLS, so this is what keeps a link in-newsroom.
  foreign key (newsroom_id, from_entry) references reference_entries (newsroom_id, id) on delete cascade,
  foreign key (newsroom_id, to_entry) references reference_entries (newsroom_id, id) on delete cascade,
  constraint reference_entry_links_kind_check
    check (kind in ('made-by', 'mentions', 'written-by', 'affiliated-with')),
  constraint reference_entry_links_not_self check (from_entry <> to_entry)
);
create index reference_entry_links_to_idx on reference_entry_links (newsroom_id, to_entry);
alter table reference_entry_links enable row level security;
alter table reference_entry_links force row level security;
create policy reference_entry_links_tenant on reference_entry_links
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select on reference_entry_links to anr_app;
grant select, insert, update, delete on reference_entry_links to anr_system;

-- migrate:down
drop table reference_entry_links;
alter table reference_entries drop constraint reference_entries_kind_check;
alter table reference_entries add constraint reference_entries_kind_check check (kind in (
  'organisation', 'person', 'product', 'benchmark', 'topic', 'paper', 'news-event'));
alter table newsrooms drop column reference;

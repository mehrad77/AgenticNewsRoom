-- migrate:up

-- An imported news item that passed every check of the gate (D184): the reader site shows it with
-- the AI label only. The gate writes a row when the item's claims, their quotes, the fact-checker
-- and the item matcher all passed, with a hash of the item's text then; a row whose hash no longer
-- matches the item is not shown as checked, so changed text keeps the imported label.
create table checked_items (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  publication_id uuid not null,
  rendition_id uuid not null,
  -- The item's path in the rendition body (`items.3`), as the gate's checks name it.
  item text not null,
  text_hash text not null,
  checked_at timestamptz not null default now(),
  unique (newsroom_id, id),
  unique (newsroom_id, publication_id, item),
  foreign key (newsroom_id, publication_id) references publications (newsroom_id, id),
  foreign key (newsroom_id, rendition_id) references renditions (newsroom_id, id)
);
alter table checked_items enable row level security;
alter table checked_items force row level security;
create policy checked_items_tenant on checked_items
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on checked_items to anr_app, anr_system;

-- migrate:down
drop table checked_items;

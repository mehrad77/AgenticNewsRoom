-- migrate:up

-- The Reference (D162): reader-facing entries of fixed kinds. Facts are data rendered by code;
-- `body` is the entry's text per language. Imported entries (D164) carry the old archive's text
-- as it was and are labelled on the site. Only the system role writes here: the legacy import
-- (D166) runs as it, and the app role reads.
create table reference_entries (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  kind text not null,
  slug text not null,
  -- The entry's name as its source writes it, usually English for papers and news.
  title text not null,
  title_language text not null default 'en',
  date date,
  date_status text,
  facts jsonb not null default '{}',
  -- Text per language: { "fa": { "<section>": "<text>", ... } }.
  body jsonb not null default '{}',
  origin text not null,
  legacy_id text,
  -- False keeps an entry out of every list and off the site (a rejected classic, D165).
  listed boolean not null default true,
  search_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (newsroom_id, id),
  unique (newsroom_id, kind, slug),
  unique (newsroom_id, legacy_id),
  constraint reference_entries_kind_check check (kind in (
    'organisation', 'person', 'product', 'benchmark', 'topic', 'paper', 'news-event')),
  constraint reference_entries_origin_check check (origin in ('imported', 'pipeline')),
  constraint reference_entries_date_status_check
    check (date_status in ('verified', 'recorded', 'approximate')),
  constraint reference_entries_slug_check check (slug ~ '^[a-z0-9][a-z0-9-]*$')
);
create index reference_entries_kind_date_idx
  on reference_entries (newsroom_id, kind, date desc) where listed;
create index reference_entries_search_idx
  on reference_entries using gin (anr.normalize_text(search_text) gin_trgm_ops) where listed;
alter table reference_entries enable row level security;
alter table reference_entries force row level security;
create policy reference_entries_tenant on reference_entries
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select on reference_entries to anr_app;
grant select, insert, update, delete on reference_entries to anr_system;

-- migrate:down
drop table reference_entries;

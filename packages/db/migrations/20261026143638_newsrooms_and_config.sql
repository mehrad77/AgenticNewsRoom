-- migrate:up
-- Configuration synced from config/ at deploy by anr_system (packages/config sync).
-- Items removed from config are soft-deleted with removed_at; ids never change.

-- The tenant itself; readable by the app (a site resolves its newsroom by host before any
-- newsroom is set), written only by config sync.
create table newsrooms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z][a-z0-9-]*$'),
  subdomain text not null unique check (subdomain ~ '^[a-z][a-z0-9-]*$'),
  name jsonb not null,
  -- The first language is the primary one.
  languages text[] not null check (cardinality(languages) >= 1 and languages <@ array['fa', 'en', 'tr']),
  timezone text not null,
  editor_in_chief text not null,
  corrections_owner text not null,
  planning jsonb not null,
  -- policy.yaml without its beats (they are rows): source rules, papers, auto_publish.
  policy jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz
);
grant select on newsrooms to anr_app;
grant select, insert, update on newsrooms to anr_system;

-- Formats are shared by all newsrooms (config/formats/<slug>/).
create table formats (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z][a-z0-9-]*$'),
  genre text not null check (genre like 'genre:%'),
  ninjs_type text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz
);
grant select on formats to anr_app;
grant select, insert, update on formats to anr_system;

create table beats (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  status text not null check (status in ('open', 'restricted', 'banned')),
  -- IPTC Media Topic qcodes (medtop:...); a lead's subjects are its beats' topics.
  media_topics text[] not null check (cardinality(media_topics) >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (newsroom_id, slug),
  unique (newsroom_id, id)
);
alter table beats enable row level security;
alter table beats force row level security;
create policy beats_tenant on beats
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select on beats to anr_app;
grant select, insert, update on beats to anr_system;

create table sources (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  -- The source's id in sources.yaml.
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  kind text not null check (kind in ('rss', 'api', 'site')),
  url text not null,
  publisher text,
  tier smallint not null check (tier between 1 and 3),
  fetch_every interval not null,
  use text not null default 'leads' check (use in ('leads', 'enrichment')),
  -- Set by a person after reading the source's terms; never fetched without it (D17).
  terms_checked date,
  terms_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (newsroom_id, slug),
  unique (newsroom_id, id)
);
alter table sources enable row level security;
alter table sources force row level security;
create policy sources_tenant on sources
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select on sources to anr_app;
grant select, insert, update on sources to anr_system;

create table series (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  format_id uuid not null references formats (id),
  languages text[] not null check (cardinality(languages) >= 1 and languages <@ array['fa', 'en', 'tr']),
  -- The rest of series/<slug>.yaml: name, cadence, items, pick, segments, hosts, narrator, channels.
  config jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (newsroom_id, slug),
  unique (newsroom_id, id)
);
alter table series enable row level security;
alter table series force row level security;
create policy series_tenant on series
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select on series to anr_app;
grant select, insert, update on series to anr_system;

-- migrate:down
drop table series;
drop table sources;
drop table beats;
drop table formats;
drop table newsrooms;

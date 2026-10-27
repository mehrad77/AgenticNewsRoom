-- migrate:up
-- Milestone 4: the publisher's send protocol, reader pages and search, restores, and the review
-- sample (docs/technical-design.md#publishing).

-- A post row per message part is written, with the text to send, before any call; `attempted_at`
-- is committed just before the call, so a row still pending with it set may have gone out and is
-- held as unknown, never re-sent (D89). `failed` is a refusal the channel gave: nothing was sent.
alter table posts
  add column body text not null default '',
  add column attempted_at timestamptz,
  add column error jsonb,
  add column updated_at timestamptz not null default now();
alter table posts alter column body drop default;
alter table posts drop constraint posts_status_check;
alter table posts add constraint posts_status_check
  check (status in ('pending', 'sent', 'unknown', 'failed'));
create index posts_publication_idx on posts (newsroom_id, publication_id);

-- Written when the publisher publishes: the page's path inside its language's site, its title
-- and search text, and whether a person changed its text (the label and the IPTC source type
-- both read this one flag).
alter table publications
  add column path text check (path ~ '^/[a-z0-9/-]+$'),
  add column title text,
  add column search_text text,
  add column edited boolean not null default false,
  add constraint publications_path_key unique (newsroom_id, language, path);
-- Site search over normalised text; reader queries filter to the same statuses, so this applies.
create index publications_search_trgm_idx on publications
  using gin (anr.normalize_text(search_text, language) gin_trgm_ops)
  where status in ('published', 'corrected');
-- Reader listings: a language's newest pieces first.
create index publications_published_idx on publications (newsroom_id, language, published_at desc)
  where status in ('published', 'corrected');

-- Database restores, written by the restore scripts. The publisher holds every scheduled
-- publication whose slot is at or before the latest one and which nobody touched since (D90).
create table restores (
  id uuid primary key default gen_random_uuid(),
  restored_at timestamptz not null default now(),
  note text
);
grant select on restores to anr_app, anr_system;
grant insert on restores to anr_system;

-- The 10% random sample of auto-published publications an editor reviews afterwards. A miss
-- records what the gate should have caught, to become a new check or policy rule (D94).
create table sample_reviews (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  publication_id uuid not null,
  sampled_at timestamptz not null default now(),
  outcome text check (outcome in ('ok', 'miss')),
  note text,
  reviewed_by uuid references users (id),
  reviewed_at timestamptz,
  check ((outcome is null) = (reviewed_at is null)),
  check (outcome is distinct from 'miss' or note is not null),
  unique (newsroom_id, publication_id),
  unique (newsroom_id, id),
  foreign key (newsroom_id, publication_id) references publications (newsroom_id, id)
);
alter table sample_reviews enable row level security;
alter table sample_reviews force row level security;
create policy sample_reviews_tenant on sample_reviews
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on sample_reviews to anr_app, anr_system;

-- A series names a channel kind and language the newsroom has not set up yet (D91).
alter table notices drop constraint notices_kind_check;
alter table notices add constraint notices_kind_check
  check (kind in ('budget-warning', 'budget-cap', 'no-leads', 'no-channel'));

-- migrate:down
alter table notices drop constraint notices_kind_check;
alter table notices add constraint notices_kind_check
  check (kind in ('budget-warning', 'budget-cap', 'no-leads'));
drop table sample_reviews;
drop table restores;
drop index publications_published_idx;
drop index publications_search_trgm_idx;
alter table publications drop constraint publications_path_key, drop column edited,
  drop column search_text, drop column title, drop column path;
drop index posts_publication_idx;
alter table posts drop constraint posts_status_check;
alter table posts add constraint posts_status_check
  check (status in ('pending', 'sent', 'unknown'));
alter table posts drop column updated_at, drop column error, drop column attempted_at,
  drop column body;

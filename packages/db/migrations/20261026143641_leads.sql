-- migrate:up
-- The lead pool. Fields follow ninjs where one exists (uri, headline, body, language, by,
-- firstCreated, versionCreated).
create table leads (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  -- Empty for a lead an agent requested from an unknown site (tier 3).
  source_id uuid,
  -- Canonical URL (ninjs uri).
  uri text not null,
  headline text,
  -- The stored text claims quote; frozen once written.
  body text not null,
  language text not null,
  byline text,
  first_created timestamptz,
  version_created timestamptz,
  content_hash text not null,
  tier smallint not null check (tier between 1 and 3),
  summary text,
  fetched_at timestamptz not null default now(),
  unique (newsroom_id, uri),
  unique (newsroom_id, id),
  foreign key (newsroom_id, source_id) references sources (newsroom_id, id)
);
create index leads_content_hash_idx on leads (newsroom_id, content_hash);
alter table leads enable row level security;
alter table leads force row level security;
create policy leads_tenant on leads
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on leads to anr_app, anr_system;

-- Claims quote a lead's stored text, so the text never changes (invariant 3).
create function anr.forbid_lead_text_change() returns trigger
language plpgsql
as $$
begin
  if new.body is distinct from old.body or new.content_hash is distinct from old.content_hash then
    raise exception 'a lead''s stored text is frozen (lead %)', old.id;
  end if;
  return new;
end;
$$;
create trigger leads_text_frozen before update on leads
  for each row execute function anr.forbid_lead_text_change();

-- The beats a lead belongs to (set by the summariser); its IPTC subjects are their topics.
create table lead_beats (
  newsroom_id uuid not null references newsrooms (id),
  lead_id uuid not null,
  beat_id uuid not null,
  primary key (lead_id, beat_id),
  foreign key (newsroom_id, lead_id) references leads (newsroom_id, id) on delete cascade,
  foreign key (newsroom_id, beat_id) references beats (newsroom_id, id)
);
create index lead_beats_beat_idx on lead_beats (newsroom_id, beat_id);
alter table lead_beats enable row level security;
alter table lead_beats force row level security;
create policy lead_beats_tenant on lead_beats
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on lead_beats to anr_app, anr_system;

-- migrate:down
drop table lead_beats;
drop table leads;
drop function anr.forbid_lead_text_change();

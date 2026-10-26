-- migrate:up
-- Every place a lead was seen: its own URL first, then each syndicated or duplicate copy. A copy
-- joins the original lead here and never becomes a second lead, so it never counts as a second
-- independent source (D57).
create table lead_sightings (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  lead_id uuid not null,
  uri text not null,
  -- Empty when the lead came from an agent's request for an unknown site.
  source_id uuid,
  -- How the copy was matched to the lead: it is the lead itself, or the same canonical URL, the
  -- same normalised text, or near-duplicate text.
  match text not null check (match in ('original', 'same-uri', 'same-hash', 'near-duplicate')),
  seen_at timestamptz not null default now(),
  unique nulls not distinct (newsroom_id, uri, source_id),
  unique (newsroom_id, id),
  foreign key (newsroom_id, lead_id) references leads (newsroom_id, id) on delete cascade,
  foreign key (newsroom_id, source_id) references sources (newsroom_id, id)
);
create index lead_sightings_lead_idx on lead_sightings (newsroom_id, lead_id);
alter table lead_sightings enable row level security;
alter table lead_sightings force row level security;
create policy lead_sightings_tenant on lead_sightings
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on lead_sightings to anr_app, anr_system;

-- migrate:down
drop table lead_sightings;

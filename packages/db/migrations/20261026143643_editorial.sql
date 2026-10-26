-- migrate:up
-- From plan to publication: editorial cycles, picks, assignments, stories, claims, renditions
-- and publications (docs/charter.md#vocabulary).

-- The planner proposes 2-3 themes per cycle; the Editor-in-Chief approves one.
create table editorial_cycles (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  starts date not null,
  ends date not null check (ends > starts),
  theme text not null,
  angle text,
  calendar jsonb,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'declined')),
  created_at timestamptz not null default now(),
  unique (newsroom_id, id)
);
create unique index editorial_cycles_one_approved on editorial_cycles (newsroom_id, starts)
  where status = 'approved';
alter table editorial_cycles enable row level security;
alter table editorial_cycles force row level security;
create policy editorial_cycles_tenant on editorial_cycles
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on editorial_cycles to anr_app, anr_system;

-- The weekly choice: three candidates; with no pick by the deadline the slot is skipped.
create table picks (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  cycle_id uuid not null,
  series_id uuid not null,
  week date not null,
  candidates jsonb not null,
  chosen smallint check (chosen between 0 and 2),
  picked_by uuid references users (id),
  deadline timestamptz not null,
  created_at timestamptz not null default now(),
  unique (newsroom_id, series_id, week),
  unique (newsroom_id, id),
  foreign key (newsroom_id, cycle_id) references editorial_cycles (newsroom_id, id),
  foreign key (newsroom_id, series_id) references series (newsroom_id, id)
);
alter table picks enable row level security;
alter table picks force row level security;
create policy picks_tenant on picks
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on picks to anr_app, anr_system;

-- The unit of work an agent receives. Cycle and pick are empty for daily news.
create table assignments (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  cycle_id uuid,
  pick_id uuid,
  series_id uuid not null,
  slot timestamptz not null,
  angle text,
  created_at timestamptz not null default now(),
  unique (newsroom_id, series_id, slot),
  unique (newsroom_id, id),
  foreign key (newsroom_id, cycle_id) references editorial_cycles (newsroom_id, id),
  foreign key (newsroom_id, pick_id) references picks (newsroom_id, id),
  foreign key (newsroom_id, series_id) references series (newsroom_id, id)
);
alter table assignments enable row level security;
alter table assignments force row level security;
create policy assignments_tenant on assignments
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on assignments to anr_app, anr_system;

create table assignment_leads (
  newsroom_id uuid not null references newsrooms (id),
  assignment_id uuid not null,
  lead_id uuid not null,
  primary key (assignment_id, lead_id),
  foreign key (newsroom_id, assignment_id) references assignments (newsroom_id, id) on delete cascade,
  foreign key (newsroom_id, lead_id) references leads (newsroom_id, id)
);
alter table assignment_leads enable row level security;
alter table assignment_leads force row level security;
create policy assignment_leads_tenant on assignment_leads
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on assignment_leads to anr_app, anr_system;

-- Researched once, format- and language-neutral.
create table stories (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  assignment_id uuid not null,
  summary text,
  created_at timestamptz not null default now(),
  unique (newsroom_id, id),
  foreign key (newsroom_id, assignment_id) references assignments (newsroom_id, id)
);
create index stories_assignment_idx on stories (newsroom_id, assignment_id);
alter table stories enable row level security;
alter table stories force row level security;
create policy stories_tenant on stories
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on stories to anr_app, anr_system;

-- One fact, quote or opinion. Facts and quotes cite a stored lead and a passage of its text.
create table claims (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  story_id uuid not null,
  kind text not null check (kind in ('fact', 'quote', 'opinion')),
  text text not null,
  lead_id uuid,
  quoted_passage text,
  created_at timestamptz not null default now(),
  check (kind = 'opinion' or (lead_id is not null and quoted_passage is not null)),
  unique (newsroom_id, id),
  foreign key (newsroom_id, story_id) references stories (newsroom_id, id),
  foreign key (newsroom_id, lead_id) references leads (newsroom_id, id)
);
create index claims_story_idx on claims (newsroom_id, story_id);
alter table claims enable row level security;
alter table claims force row level security;
create policy claims_tenant on claims
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on claims to anr_app, anr_system;

-- One story in one format and one language; each body item lists the claim ids it relies on.
create table renditions (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  story_id uuid not null,
  format_id uuid not null references formats (id),
  language text not null check (language in ('fa', 'en', 'tr')),
  body jsonb not null,
  created_at timestamptz not null default now(),
  unique (newsroom_id, id),
  foreign key (newsroom_id, story_id) references stories (newsroom_id, id)
);
create index renditions_story_idx on renditions (newsroom_id, story_id);
alter table renditions enable row level security;
alter table renditions force row level security;
create policy renditions_tenant on renditions
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on renditions to anr_app, anr_system;

-- What goes out in one slot. Status follows the lifecycle in docs/technical-design.md
-- (PUBLICATION_STATUSES in @anr/core).
create table publications (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  series_id uuid not null,
  assignment_id uuid,
  slot timestamptz not null,
  language text not null check (language in ('fa', 'en', 'tr')),
  status text not null default 'assigned'
    check (status in ('assigned', 'drafted', 'with-editor', 'scheduled', 'published', 'corrected')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (newsroom_id, series_id, slot, language),
  unique (newsroom_id, id),
  foreign key (newsroom_id, series_id) references series (newsroom_id, id),
  foreign key (newsroom_id, assignment_id) references assignments (newsroom_id, id)
);
-- The publisher's sweep: scheduled publications whose slot has come.
create index publications_due_idx on publications (slot) where status = 'scheduled';
alter table publications enable row level security;
alter table publications force row level security;
create policy publications_tenant on publications
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on publications to anr_app, anr_system;

create table publication_renditions (
  newsroom_id uuid not null references newsrooms (id),
  publication_id uuid not null,
  position smallint not null check (position >= 1),
  rendition_id uuid not null,
  primary key (publication_id, position),
  foreign key (newsroom_id, publication_id) references publications (newsroom_id, id) on delete cascade,
  foreign key (newsroom_id, rendition_id) references renditions (newsroom_id, id)
);
alter table publication_renditions enable row level security;
alter table publication_renditions force row level security;
create policy publication_renditions_tenant on publication_renditions
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on publication_renditions to anr_app, anr_system;

-- migrate:down
drop table publication_renditions;
drop table publications;
drop table renditions;
drop table claims;
drop table stories;
drop table assignment_leads;
drop table assignments;
drop table picks;
drop table editorial_cycles;

-- migrate:up
-- Every result of the verifier gate, so a hold always has a reason. A check is about a claim,
-- a rendition (item) or a whole publication (policy).
create table checks (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  claim_id uuid,
  rendition_id uuid,
  -- The rendition item checked, as a path into the rendition body.
  item text,
  publication_id uuid,
  kind text not null check (kind in ('code', 'fact-check', 'item-match', 'policy')),
  -- Which check ran, such as quote-match or source-independence.
  name text not null,
  -- Anything but pass holds the publication for an editor (invariant 5).
  result text not null check (result in ('pass', 'fail', 'partial', 'error', 'timed-out')),
  detail jsonb,
  at timestamptz not null default now(),
  check (num_nonnulls(claim_id, rendition_id, publication_id) >= 1),
  unique (newsroom_id, id),
  foreign key (newsroom_id, claim_id) references claims (newsroom_id, id),
  foreign key (newsroom_id, rendition_id) references renditions (newsroom_id, id),
  foreign key (newsroom_id, publication_id) references publications (newsroom_id, id)
);
create index checks_claim_idx on checks (newsroom_id, claim_id);
create index checks_rendition_idx on checks (newsroom_id, rendition_id);
create index checks_publication_idx on checks (newsroom_id, publication_id);
alter table checks enable row level security;
alter table checks force row level security;
create policy checks_tenant on checks
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on checks to anr_app, anr_system;

-- One sent message. The publisher writes the row before calling the channel and stores the
-- channel's id after; a retry that finds an id skips the send, an unknown result is held.
create table posts (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  publication_id uuid not null,
  channel_id uuid not null,
  -- Numbers the messages of a split Telegram post.
  part smallint not null default 1 check (part >= 1),
  idempotency_key text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'unknown')),
  external_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (publication_id, channel_id, part),
  -- Per newsroom: a key never collides with, or reveals, another newsroom's.
  unique (newsroom_id, idempotency_key),
  unique (newsroom_id, id),
  foreign key (newsroom_id, publication_id) references publications (newsroom_id, id),
  foreign key (newsroom_id, channel_id) references channels (newsroom_id, id)
);
alter table posts enable row level security;
alter table posts force row level security;
create policy posts_tenant on posts
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on posts to anr_app, anr_system;

-- Images with their IPTC Photo Metadata. The publisher refuses media without a licence.
create table media (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  -- Object storage key.
  file text not null,
  lead_id uuid,
  creator text,
  credit_line text,
  copyright_notice text,
  web_statement text,
  licensor text,
  -- As recorded in the image's own metadata; never guessed.
  digital_source_type text,
  licence text,
  created_at timestamptz not null default now(),
  unique (newsroom_id, id),
  foreign key (newsroom_id, lead_id) references leads (newsroom_id, id)
);
alter table media enable row level security;
alter table media force row level security;
create policy media_tenant on media
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on media to anr_app, anr_system;

-- A reader's challenge: acknowledged within 24 hours, answered within 48 (D10).
create table challenges (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  publication_id uuid not null,
  reader_text text not null,
  owner text not null,
  acknowledge_by timestamptz not null,
  answer_by timestamptz not null,
  acknowledged_at timestamptz,
  answered_at timestamptz,
  outcome text check (outcome in ('upheld', 'rejected')),
  created_at timestamptz not null default now(),
  unique (newsroom_id, id),
  foreign key (newsroom_id, publication_id) references publications (newsroom_id, id)
);
alter table challenges enable row level security;
alter table challenges force row level security;
create policy challenges_tenant on challenges
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on challenges to anr_app, anr_system;

-- A published correction, linked to the new check it adds.
create table corrections (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  publication_id uuid not null,
  challenge_id uuid,
  check_id uuid,
  notice text not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (newsroom_id, id),
  foreign key (newsroom_id, publication_id) references publications (newsroom_id, id),
  foreign key (newsroom_id, challenge_id) references challenges (newsroom_id, id),
  foreign key (newsroom_id, check_id) references checks (newsroom_id, id)
);
alter table corrections enable row level security;
alter table corrections force row level security;
create policy corrections_tenant on corrections
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on corrections to anr_app, anr_system;

-- migrate:down
drop table corrections;
drop table challenges;
drop table media;
drop table posts;
drop table checks;

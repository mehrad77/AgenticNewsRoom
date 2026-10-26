-- migrate:up
-- People who can sign in to the editor's desk (Cloudflare Access maps an email to a user).
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));
grant select on users to anr_app;
grant select, insert, update on users to anr_system;

create table memberships (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  user_id uuid not null references users (id),
  role text not null check (role in ('editor-in-chief', 'editor')),
  created_at timestamptz not null default now(),
  unique (newsroom_id, user_id),
  unique (newsroom_id, id)
);
alter table memberships enable row level security;
alter table memberships force row level security;
create policy memberships_tenant on memberships
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on memberships to anr_app, anr_system;

-- Every approval and edit, append-only. Written through recordAudit() in @anr/db.
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null default anr.current_newsroom_id() references newsrooms (id),
  -- Who acted: a person (a desk user), an agent role, or a code component.
  actor_kind text not null check (actor_kind in ('person', 'agent', 'code')),
  actor_user_id uuid references users (id),
  actor_name text,
  action text not null,
  -- The table and row acted on.
  entity text not null,
  entity_id uuid not null,
  before jsonb,
  after jsonb,
  -- clock_timestamp(), not now(): entries of one transaction keep their order.
  at timestamptz not null default clock_timestamp(),
  check ((actor_kind = 'person') = (actor_user_id is not null)),
  check (actor_kind = 'person' or actor_name is not null)
);
create index audit_log_entity_idx on audit_log (newsroom_id, entity, entity_id, at);
alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy audit_log_tenant on audit_log
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
-- Append-only: no role is granted update or delete, and the triggers stop the owner too.
grant select, insert on audit_log to anr_app, anr_system;
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function anr.forbid_change();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function anr.forbid_change();

-- Where publications go out. Data, set up in the editor's desk; never config (invariant 7).
create table channels (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  kind text not null check (kind in ('site', 'telegram', 'podcast-rss')),
  language text not null check (language in ('fa', 'en', 'tr')),
  -- The channel's own id, such as a Telegram chat id.
  external_id text,
  -- Sealed with the platform key by sealCredentials() in @anr/db; never stored in clear.
  credentials bytea,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (newsroom_id, id)
);
alter table channels enable row level security;
alter table channels force row level security;
create policy channels_tenant on channels
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on channels to anr_app, anr_system;

-- migrate:down
drop table channels;
drop table audit_log;
drop table memberships;
drop table users;

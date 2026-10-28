-- migrate:up
-- Text-to-speech engines (D113): the platform admin enables engines from the models file's
-- catalogue; each newsroom chooses one per language from those.

-- The platform admin: at most one person, named by the operator (desk:admin).
alter table users add column platform_admin boolean not null default false;
create unique index users_one_platform_admin on users (platform_admin) where platform_admin;

-- Settings that belong to no newsroom, such as which TTS engines are available.
create table platform_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9.-]*$'),
  value jsonb not null,
  updated_by uuid references users (id),
  updated_at timestamptz not null default now()
);
grant select, insert, update on platform_settings to anr_app, anr_system;

-- Every change to a platform setting, append-only like the newsrooms' audit log.
create table platform_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users (id),
  actor_name text,
  action text not null,
  entity text not null,
  key text not null,
  before jsonb,
  after jsonb,
  at timestamptz not null default clock_timestamp(),
  check (actor_user_id is not null or actor_name is not null)
);
grant select, insert on platform_audit_log to anr_app, anr_system;
create trigger platform_audit_log_append_only before update or delete on platform_audit_log
  for each row execute function anr.forbid_change();
create trigger platform_audit_log_no_truncate before truncate on platform_audit_log
  for each statement execute function anr.forbid_change();

-- A newsroom's TTS engine per language; the publisher voices its episodes with it.
create table newsroom_tts (
  id uuid primary key default gen_random_uuid(),
  newsroom_id uuid not null references newsrooms (id),
  language text not null check (language in ('fa', 'en', 'tr')),
  engine text not null check (engine ~ '^[a-z0-9][a-z0-9.-]*$'),
  updated_at timestamptz not null default now(),
  unique (newsroom_id, language),
  unique (newsroom_id, id)
);
alter table newsroom_tts enable row level security;
alter table newsroom_tts force row level security;
create policy newsroom_tts_tenant on newsroom_tts
  using (newsroom_id = (select anr.current_newsroom_id()))
  with check (newsroom_id = (select anr.current_newsroom_id()));
grant select, insert, update, delete on newsroom_tts to anr_app, anr_system;

-- migrate:down
drop table newsroom_tts;
drop table platform_audit_log;
drop table platform_settings;
drop index users_one_platform_admin;
alter table users drop column platform_admin;

-- migrate:up

-- People through the API (D190): the Editor-in-Chief adds a member by email, which creates the
-- user if there is none, and the platform admin hands the role over (D113). Both were scripts on
-- the host, writing as anr_system.
grant insert on users to anr_app;
grant update (platform_admin) on users to anr_app;

-- Every deploy, written by infra/deploy.sh (D193): the platform admin reads which release runs.
create table deploys (
  id uuid primary key default gen_random_uuid(),
  tag text not null check (tag ~ '^v[0-9A-Za-z.+-]+$'),
  at timestamptz not null default now(),
  ok boolean not null,
  detail text
);
create index deploys_at on deploys (at desc);
grant select on deploys to anr_app;
grant select, insert on deploys to anr_system;

-- Which migration the database is at, for the same page.
grant select on schema_migrations to anr_app;

-- migrate:down
revoke select on schema_migrations from anr_app;
drop table deploys;
revoke update (platform_admin) on users from anr_app;
revoke insert on users from anr_app;

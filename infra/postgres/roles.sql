-- The platform's database roles and databases. Idempotent: run by initdb/00-roles.sh on an empty
-- volume, and again by `anr-roles` to rotate passwords (a restore brings back the old ones).
-- psql variables: migrator_password, app_password, system_password, databases (space-separated).
\set ON_ERROR_STOP on

-- psql variables do not expand inside DO $$...$$ blocks, so statements are generated with
-- format(%L) and run by \gexec.
select format('create role %I login', r)
from unnest(array['anr_migrator', 'anr_app', 'anr_system']) as r
where not exists (select from pg_roles where rolname = r)
\gexec

alter role anr_migrator login nosuperuser nocreatedb nocreaterole nobypassrls password :'migrator_password';
alter role anr_app login nosuperuser nocreatedb nocreaterole nobypassrls password :'app_password';
-- Cross-newsroom jobs only (config sync, the publisher's sweep). BYPASSRLS grants no table access.
alter role anr_system login nosuperuser nocreatedb nocreaterole bypassrls password :'system_password';

select format('create database %I owner anr_migrator', d)
from unnest(string_to_array(:'databases', ' ')) as d
where d <> '' and not exists (select from pg_database where datname = d)
\gexec

select format('revoke all on database %1$I from public; grant connect on database %1$I to anr_migrator, anr_app, anr_system', d)
from unnest(string_to_array(:'databases', ' ')) as d
where d <> ''
\gexec

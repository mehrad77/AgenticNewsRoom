-- Dev-only bootstrap, run once by the postgres image on an empty volume.
-- Production creates the same roles with real passwords from the environment.
create role anr_migrator login password 'anr_migrator';
create role anr_app login password 'anr_app';
create role anr_system login password 'anr_system' bypassrls;
create database anr owner anr_migrator;
\connect anr
create extension if not exists pg_trgm;
grant usage on schema public to anr_app, anr_system;

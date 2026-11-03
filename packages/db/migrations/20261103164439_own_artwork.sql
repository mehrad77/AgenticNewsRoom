-- migrate:up

-- The newsroom's own artwork (D180): images the newsroom made for itself (podcast show art, its
-- header, episode covers, host avatars), made with AI. Licence kind `own`: credited to the
-- newsroom, published like any licensed image (D120). `role` names the artwork the site looks up
-- by name, such as `series/weekly-podcast/show` or `series/weekly-podcast/host/niloofar`.
alter table media drop constraint media_licence_kind_check;
alter table media add constraint media_licence_kind_check
  check (licence_kind = any (array['press-kit', 'commons', 'own']));
alter table media add column role text;
alter table media add constraint media_role_check check (role ~ '^[a-z0-9][a-z0-9/-]*$');
create unique index media_role_idx on media (newsroom_id, role) where role is not null;

-- migrate:down
drop index media_role_idx;
alter table media drop constraint media_role_check;
alter table media drop column role;
alter table media drop constraint media_licence_kind_check;
alter table media add constraint media_licence_kind_check
  check (licence_kind = any (array['press-kit', 'commons']));

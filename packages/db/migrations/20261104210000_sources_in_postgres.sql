-- migrate:up

-- Sources move to Postgres (D192). A source belongs to its newsroom's sources.yaml until a person
-- changes it through the API (`edited_at`); config sync then never overwrites or removes it.
-- Whoever records that they read the terms is kept with when (D17).
alter table sources
  add column edited_at timestamptz,
  add column edited_by uuid references users (id),
  add column terms_checked_by uuid references users (id),
  add column terms_checked_at timestamptz;
grant insert, update on sources to anr_app;

-- migrate:down
revoke insert, update on sources from anr_app;
alter table sources
  drop column terms_checked_at,
  drop column terms_checked_by,
  drop column edited_by,
  drop column edited_at;

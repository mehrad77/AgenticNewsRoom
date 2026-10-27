-- migrate:up
-- The editor's desk tools: a channel's last check, and the issue a sample miss was filed as.

-- Written by the publisher when the Editor-in-Chief tests a channel (or replaces its token): what
-- the channel said, without sending anything (D101).
alter table channels
  add column checked_at timestamptz,
  add column check_result jsonb;

-- A miss is filed as an issue in the platform's tracker; the check or policy rule made from it
-- links back to that issue (D102).
alter table sample_reviews
  add column issue_url text check (issue_url ~ '^https://'),
  add column filed_at timestamptz,
  add constraint sample_reviews_filed_check check ((issue_url is null) = (filed_at is null)),
  add constraint sample_reviews_filed_miss_check check (issue_url is null or outcome = 'miss');

-- migrate:down
alter table sample_reviews drop constraint sample_reviews_filed_miss_check,
  drop constraint sample_reviews_filed_check, drop column filed_at, drop column issue_url;
alter table channels drop column check_result, drop column checked_at;

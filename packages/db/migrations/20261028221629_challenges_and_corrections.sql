-- migrate:up

-- A reader's challenge (D114). Nothing about the reader is stored: the status link's token is kept
-- as its hash, and the rate key is an HMAC of address and user agent under a daily secret.
alter table challenges
  add column token_hash bytea not null,
  add column reader_key text not null,
  add column source_url text,
  add column acknowledgement text,
  add column answer text,
  add column acknowledged_by uuid references users (id),
  add column answered_by uuid references users (id),
  add column issue_url text,
  add column filed_at timestamptz,
  add constraint challenges_reader_text_check check (length(reader_text) between 20 and 4000),
  add constraint challenges_acknowledged_check
    check ((acknowledged_at is null) = (acknowledged_by is null)),
  add constraint challenges_answered_check
    check ((answered_at is null) = (outcome is null) and (answered_at is null) = (answer is null));
create index challenges_rate_idx on challenges (newsroom_id, publication_id, created_at);
create index challenges_open_idx on challenges (newsroom_id) where answered_at is null;

-- One correction per affected publication of an upheld challenge, each in its own language (D115).
alter table corrections
  add constraint corrections_challenge_publication_key unique (challenge_id, publication_id);

-- A correction's check: the corrected claim, failed by a person. The gate fails every claim
-- copied from it (D116).
alter table checks drop constraint checks_kind_check;
alter table checks add constraint checks_kind_check
  check (kind in ('code', 'fact-check', 'item-match', 'policy', 'correction'));

alter table notices drop constraint notices_kind_check;
alter table notices add constraint notices_kind_check
  check (kind in ('budget-warning', 'budget-cap', 'no-leads', 'no-channel', 'no-theme',
                  'pick-missed', 'plan-failed', 'challenge-due', 'challenge-overdue'));

-- migrate:down
alter table notices drop constraint notices_kind_check;
alter table notices add constraint notices_kind_check
  check (kind in ('budget-warning', 'budget-cap', 'no-leads', 'no-channel', 'no-theme',
                  'pick-missed', 'plan-failed'));
alter table checks drop constraint checks_kind_check;
alter table checks add constraint checks_kind_check
  check (kind in ('code', 'fact-check', 'item-match', 'policy'));
alter table corrections drop constraint corrections_challenge_publication_key;
drop index challenges_open_idx;
drop index challenges_rate_idx;
alter table challenges
  drop constraint challenges_answered_check,
  drop constraint challenges_acknowledged_check,
  drop constraint challenges_reader_text_check,
  drop column filed_at,
  drop column issue_url,
  drop column answered_by,
  drop column acknowledged_by,
  drop column answer,
  drop column acknowledgement,
  drop column source_url,
  drop column reader_key,
  drop column token_hash;

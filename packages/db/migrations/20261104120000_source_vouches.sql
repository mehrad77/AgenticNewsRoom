-- migrate:up

-- A source vouches for its own section of its host and the sections it lists (D61, D187); a vouch
-- source is never fetched and only vouches. Both serve agents' source requests: an official page a
-- lab publishes outside its feed is tier 1 like the feed's.
alter table sources drop constraint sources_use_check;
alter table sources add constraint sources_use_check
  check (use in ('leads', 'enrichment', 'vouch'));
alter table sources add column vouches text[] not null default '{}';

-- migrate:down
alter table sources drop column vouches;
alter table sources drop constraint sources_use_check;
alter table sources add constraint sources_use_check check (use in ('leads', 'enrichment'));

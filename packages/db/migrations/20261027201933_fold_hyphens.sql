-- migrate:up
-- Hyphen (U+2010; NFKC maps the non-breaking hyphen U+2011 to it) and minus sign (U+2212) fold
-- to the hyphen-minus: models write them where sources have "-" (D86). The function is
-- immutable, so the trigram index built on it is rebuilt.
create or replace function anr.normalize_text(input text, language text default null) returns text
language sql immutable parallel safe
return (
  select case
    when language = 'tr' then lower(mapped collate "tr-TR-x-icu") collate "default"
    else lower(mapped collate "und-x-icu") collate "default"
  end
  from (
    -- translate() maps by position and deletes characters past the end of the target, so the
    -- zero-width non-joiner comes last.
    select translate(
      normalize(input, nfkc),
      U&'\064A\0649\0643\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\2010\2011\2212\200C',
      U&'\06CC\06CC\06A9' || '01234567890123456789---'
    ) as mapped
  ) as t
);
reindex index leads_search_trgm_idx;

-- migrate:down
create or replace function anr.normalize_text(input text, language text default null) returns text
language sql immutable parallel safe
return (
  select case
    when language = 'tr' then lower(mapped collate "tr-TR-x-icu") collate "default"
    else lower(mapped collate "und-x-icu") collate "default"
  end
  from (
    select translate(
      normalize(input, nfkc),
      U&'\064A\0649\0643\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\200C',
      U&'\06CC\06CC\06A9' || '01234567890123456789'
    ) as mapped
  ) as t
);
reindex index leads_search_trgm_idx;

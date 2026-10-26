-- migrate:up
-- Text normalisation for quote matching and search (docs/technical-design.md#verifier-gate).
-- The verifier's Python normaliser applies the same rules; both are tested against
-- packages/schemas/fixtures/normalization.json.
--   1. NFKC, which also folds Arabic presentation forms into their base letters.
--   2. Zero-width non-joiner removed.
--   3. Arabic ye and alef maksura to Persian ye, Arabic kaf to Persian kaf.
--   4. Persian and Arabic-Indic digits to ASCII digits.
--   5. Lower case with an explicit ICU collation, Turkish rules for Turkish text, so the result
--      matches Python's str.lower() and never depends on the server's OS locale.
-- Immutable, so expression and trigram indexes can use it. An ICU upgrade that changes case
-- mapping means reindexing those indexes.
create function anr.normalize_text(input text, language text default null) returns text
language sql immutable parallel safe
return (
  -- Each branch is re-labelled with the default collation; CASE cannot mix explicit ones.
  select case
    when language = 'tr' then lower(mapped collate "tr-TR-x-icu") collate "default"
    else lower(mapped collate "und-x-icu") collate "default"
  end
  from (
    -- translate() maps by position and deletes characters past the end of the target, so the
    -- zero-width non-joiner comes last.
    select translate(
      normalize(input, nfkc),
      U&'\064A\0649\0643\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\200C',
      U&'\06CC\06CC\06A9' || '01234567890123456789'
    ) as mapped
  ) as t
);

-- migrate:down
drop function anr.normalize_text(text, text);

# tools/legacy-import

One-off import of the old system's knowledge base into a newsroom's Reference (D161, D165, D166).

- Input: an export directory written by `pnpm kb:pull` in the old repo (`lab-news.jsonl`, `posts.jsonl`, `classic-candidates/*.json`).
- `src/anr_legacy_import/mapping.py` is pure (rows in, entries out) and tested; which rows are listed follows the old site exactly. `write.py` upserts on `(newsroom_id, legacy_id)` as the system role, the only role that may write `origin = imported` (D164).
- Nothing here names a newsroom (invariant 9): the target is `--newsroom`, the old channel's username is `--telegram-channel`.
- Run: `pnpm --filter @anr/legacy-import legacy-import --newsroom ai --export <dir> --telegram-channel singularity_takinegi --dry-run`, then again without `--dry-run`.
- English (D169): `--units <file>` writes the Persian texts still to translate; `pnpm --filter @anr/legacy-import translate <units> <translations>` (`translate/`, TypeScript, through `@anr/models` on the renderer's chain) appends checked translations to a cache keyed by the text's hash; `--translations <file>` merges the cache. `translate/units.ts` is pure and tested. For the bulk run, `pnpm --filter @anr/legacy-import translate:batch <units> <translations> --budget <usd>` (`translate/anthropic-batch.ts`, `ANTHROPIC_API_KEY`) uses the Message Batches API on Claude Sonnet 5.5 at half price: it counts input tokens first, submits only what fits the cap in the worst case, keeps a spend ledger beside the translations file and resumes a submitted batch instead of paying twice.
- The old wiki: `--site-data <old repo>/apps/archive/src/data` adds organisations (KB entities, the alias table and news orgs, merged by Wikidata QID or English name), products and people (authors of two or more listed papers), and the links to them (`entities.py`). Only kinds the newsroom's `reference.yaml` declares are written (D170); links are rebuilt on each run.
- Imported so far: lab news, classic papers, and the organisations, products and people they name. Other papers, topics, benchmarks, logos and podcast episodes (D165) are still to come.

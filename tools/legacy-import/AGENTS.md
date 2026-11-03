# tools/legacy-import

One-off import of the old system's knowledge base into a newsroom's Reference (D161, D165, D166).

- Input: an export directory written by `pnpm kb:pull` in the old repo (`lab-news.jsonl`, `posts.jsonl`, `classic-candidates/*.json`).
- `src/anr_legacy_import/mapping.py` is pure (rows in, entries out) and tested; which rows are listed follows the old site exactly. `write.py` upserts on `(newsroom_id, legacy_id)` as the system role, the only role that may write `origin = imported` (D164).
- Nothing here names a newsroom (invariant 9): the target is `--newsroom`, the old channel's username is `--telegram-channel`.
- Run: `pnpm --filter @anr/legacy-import legacy-import --newsroom ai --export <dir> --telegram-channel singularity_takinegi --dry-run`, then again without `--dry-run`.
- Imported so far: lab news and classic papers. Papers, the wiki and podcast episodes (D165) are still to come.

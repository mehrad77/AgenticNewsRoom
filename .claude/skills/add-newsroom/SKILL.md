---
name: add-newsroom
description: Add a new ANR newsroom (tenant) from configuration alone. Use when asked to add, start or set up a newsroom, or to change a newsroom's languages, beats, sources or series.
---

# Add a newsroom

A newsroom is configuration plus channels set up in the editor's desk. Adding one must need **no code**: that is ANR's v1 test (`docs/charter.md#v1-scope`). If a step below seems to need code, stop: the platform is missing a generic feature. Say which, and build it as a platform feature first.

## Steps

1. Pick a slug (`^[a-z][a-z0-9-]*$`). Create `config/newsrooms/<slug>/`.
2. `newsroom.yaml` (schema: `packages/schemas/json/newsroom.schema.json`):
   - `languages`: the first is primary. Only `fa`, `en`, `tr` exist today; a new language is a platform change (direction in `packages/core/src/languages.ts`, normaliser vectors, disclosure partial, style lint).
   - `subdomain`: unique across newsrooms; the site is served at `<subdomain>.$ANR_ROOT_DOMAIN`.
   - `editor_in_chief`, `corrections_owner`: people's names, never emails.
   - `planning`: `cycle` is the editorial cycle's length (`10d`, `2w`, `1mo`, …) and `from` the first cycle's start date; cycles run back to back in the newsroom's timezone. Never assume a month.
3. `policy.yaml`: every beat as `{ status, media_topics }`: status `open`, `restricted` or `banned`, and one or more IPTC Media Topic qcodes (`medtop:<8 digits>`) looked up in `packages/schemas/iptc/mediatopic.json`, never from memory, and not retired; `sources.min_independent` ≥ 2; `auto_publish` lists only formats that may publish as daily news without an editor (themed work never auto-publishes).
4. `sources.yaml`: one entry per source with a verified URL, `publisher`, `tier` (1 = primary: the subject's own statement, filing or paper), `every`. Leave `terms_checked` unset: a person sets it after reading the source's terms, and ingestion never fetches a source without it.
5. `series/<series>.yaml`: format (an existing folder in `config/formats/`), languages (subset of the newsroom's), cadence, picks or segments, podcast hosts and TTS voices per language, and channel kinds per language. Each channel kind needs the format's `templates/<kind>.liquid`.
6. `style.md`: the newsroom's style guide with an "All languages" section and one section per language. Keep it short; it goes into every desk prompt (target under 5 KB of prompt in total).
7. Run `pnpm config:check`, then `pnpm check`.
8. Document the newsroom in `docs/first-newsrooms.md` (or a new doc linked from `docs/README.md`).

Outside the repo (tell the user; do not do these): a DNS record for the subdomain, and the newsroom's channels (site, Telegram, podcast feeds) created by the Editor-in-Chief in the editor's desk.

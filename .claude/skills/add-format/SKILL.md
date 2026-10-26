---
name: add-format
description: Add or change an ANR format (the shape of a rendition, e.g. newsletter issue, article, podcast episode). Use when asked for a new kind of output or to change a format's schema, templates, checks or writing guide.
---

# Add a format

A format is configuration shared by all newsrooms: `config/formats/<format>/`.

## Files

- `schema.json`: JSON Schema (draft 2020-12) for the draft an agent submits. Keep the shared shape: optional `story` (summary, beat, claims with `id`, `kind` fact|quote|opinion, `text`, `lead_id`, `quoted_passage`) and required `rendition` (`language`, `title`, `items`). **Every rendition item lists `claim_ids`.** Copy the `$defs` from an existing format.
- `templates/<channel>.liquid`: one per channel kind the format can go to (`site`, `telegram`, `podcast-rss`). **Every template renders `{% render "disclosure", language: language, edited: edited %}`**; the verifier fails output without the label. Templates own channel limits (Telegram's 4,096 characters and how a long post splits).
- `checks.yaml`: format-specific code checks run by the verifier (`id` + `rule`).
- `format.yaml`: `genre`, one live IPTC genre qcode from `packages/schemas/iptc/genre.json` (opinion items add `genre:Opinion` on their own), and `ninjs_type` (`text` or `audio`).
- `guide.md`: a short writing guide for the agent (a few bullets; it is part of the prompt budget).

## Then

1. `pnpm gen` (regenerates zod and pydantic models from the schema) and commit the generated files.
2. `pnpm check`.
3. If a newsroom should use it, add a series in that newsroom's `series/` (see the `add-newsroom` skill).
4. Newsrooms may override a format's templates or guide in their own folder, never its schema or checks.
5. Update `docs/technical-design.md` if the format introduces a new concept, and `docs/decisions.md` if a choice was made.

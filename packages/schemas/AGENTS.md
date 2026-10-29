# @anr/schemas

JSON Schema is the source of truth; zod (TypeScript) and pydantic (Python) are generated from it.

- Sources: `json/*.schema.json` (config files, and the ingestion service's HTTP bodies: `ingest-*`, `source-request*`, `media-request*`) and `config/formats/<format>/schema.json` (draft submits).
- Generated, never edited by hand: `src/generated/` (zod) and `python/anr_schemas/{config,formats}/` (pydantic).
- After changing a schema run `pnpm gen`; CI fails if generated code is stale (`pnpm gen:check`).
- `iptc/`: vendored IPTC vocabularies (Media Topics, genre, digital source type, trust indicators) and the ninjs 3.2 JSON Schema; see `iptc/README.md`. Refresh only with `pnpm --filter @anr/schemas iptc`, never by hand. Look codes up there, never from memory.
- `python/anr_schemas/text.py` (hand-written) is the one Python text normaliser, used by the verifier (quote matching) and ingestion (content hash). `fixtures/normalization.json` holds its test vectors, shared with the SQL function `anr.normalize_text()`.
- Schema viewer: `pnpm schemas:view`, then http://localhost:4400 (port: `SCHEMA_VIEWER_PORT`). It lists the config and format schemas with `$ref`s inlined, as a collapsible tree with types, required fields and constraints. Reads from disk on each load, so edits show on refresh. No dependencies beyond the package's own.

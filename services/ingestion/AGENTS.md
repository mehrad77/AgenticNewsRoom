# anr-ingestion (Python)

Turns sources into stored leads: fetch → extract (raw page kept) → deduplicate (canonical URL, content hash, near-duplicate text) → tier → store (frozen text). The summariser then runs per new lead, as an agent run started by the TypeScript job. See `docs/technical-design.md#ingestion` and D55–D62.

- Internal HTTP only, called by the agents worker: `POST /ingest` (one source, the `ingest-source` job) and `POST /request-source` (an agent run's page request). Bodies are the JSON Schemas `ingest-*` and `source-request*` in `packages/schemas`. Port 8101 in dev, 8000 in Compose.
- `POST /media` (D119): a desk member's image by URL; `media.py` (pure) reads its XMP Photo Metadata and, for a Commons file page, records a free licence (CC0, public domain, CC BY, CC BY-SA) credited `"<Artist>, Wikimedia Commons"`. Any other image needs a `source_url` and stays unlicensed until a person records its press kit.
- Every request goes through `net.Fetcher` (D58): never add another HTTP client. Pages are fetched under robots.txt; only an `api` source's own API calls skip it (D64). Never fetch a source without `terms_checked`; enrichment sources add no leads. A lead from an unknown site is tier 3.
- `pipeline.py` orchestrates; `kinds.py` parses each kind of source (an `api` adapter is chosen by host); `extract.py`, `canonical.py`, `dedupe.py`, `tier.py` are pure; `store.py` holds the SQL, always inside `db.with_newsroom()` as `anr_app`. Ingestion never migrates.
- Text normalisation is `anr_schemas.text`, shared with the verifier.
- A stored lead is never changed or deleted when it turns out withdrawn: it is marked (`store.mark_withdrawn`, D78). Each arXiv run asks arXiv about its papers of the last 30 days by `id_list`.
- Tests use recorded fixtures in `tests/fixtures/` (`web.json` maps URLs to files), never the network. Database tests run against `anr_test` and fail without it; they run after `@anr/config#test`, whose sync soft-deletes newsrooms not in `config/`.
- `ANR_INGESTION_REPLAY=<dir>` serves a fixtures directory instead of the web (tests and fixture runs only).
- Commands: `pnpm --filter @anr/ingestion test|lint|typecheck|dev`.

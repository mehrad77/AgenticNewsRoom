# anr-verifier (Python)

Layer 1 of the verifier gate: code checks on drafts. See `docs/technical-design.md#verifier-gate` and D79.

- Checks: rendition schema; every claim's passages (and its further sources') are in its leads' stored text after normalisation and whitespace collapse, none withdrawn; two independent publishers or one tier-1 source; no opinion where policy forbids it, and marked opinion where it allows it (D117); no claim a person corrected, or a copy of one (D116); no banned or unplaced beat, restricted beats listed for policy; every rendition item lists known claims and its numbers and Latin-script names are in them; outside-article leads exist; style lint per language; the format's `checks.yaml` rules.
- Normalisation (`anr_schemas.text`, shared with ingestion): NFKC, zero-width non-joiners, Arabic/Persian ye and kaf, Persian and Arabic-Indic digits, lower case with Turkish rules for Turkish. Test vectors: `packages/schemas/fixtures/normalization.json`, shared with the SQL function `anr.normalize_text()`; a change to one needs the same change to the other.
- `POST /verify` (bodies: JSON Schemas `verify-request`, `verify-result`) loads the story as `anr_app` inside `db.with_newsroom()`, runs every check and stores every result as a Check in one transaction, so a hold always has a reason. The gate can hold, never approve.
- Checks are pure functions over a `Bundle` (`claims.py`, `items.py`, `rendition.py`); only `verify.py` touches Postgres. A story-wide result is stored once per rendition.
- `checks.yaml` rules are implemented by id in `rendition.RULES`, their numbers read from the rule text; an id without code is an `error` check, which holds. `tests/test_checks.py` lists the ids still pending (podcast rules, milestone 5).
- The disclosure label is checked by the agents worker's gate with `@anr/render`, not here.
- Database tests run against `anr_test` and fail without it.
- Internal HTTP only, port 8102 in dev, 8000 in Compose. Commands: `pnpm --filter @anr/verifier test|lint|typecheck|dev`.

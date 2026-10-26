# anr-verifier (Python)

Layer 1 of the verifier gate: code checks on drafts. See `docs/technical-design.md#verifier-gate`.

- Checks: format schema; every claim names a lead in this newsroom and its quote is in the lead's stored text (after normalisation); two independent publishers or one tier-1 source (more if the beat requires); no banned beat, restricted beats marked for an editor; every rendition item lists claim ids and its numbers, dates and names match them; disclosure label present; style lint per language.
- Normalisation (`anr_schemas.text`, shared with ingestion): NFKC, zero-width non-joiners, Arabic/Persian ye and kaf, Persian and Arabic-Indic digits, lower case with Turkish rules for Turkish. Test vectors: `packages/schemas/fixtures/normalization.json`, shared with the SQL function `anr.normalize_text()`; a change to one needs the same change to the other.
- Every result is stored as a Check, so a hold always has a reason. The gate can hold, never approve.
- Internal HTTP only, port 8102 in dev. Commands: `pnpm --filter @anr/verifier test|lint|typecheck|dev`.

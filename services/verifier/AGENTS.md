# anr-verifier (Python)

Layer 1 of the verifier gate: code checks on drafts. See `docs/technical-design.md#verifier-gate`.

- Checks: format schema; every claim names a lead in this newsroom and its quote is in the lead's stored text (after normalisation); two independent publishers or one tier-1 source (more if the beat requires); no banned beat, restricted beats marked for an editor; every rendition item lists claim ids and its numbers, dates and names match them; disclosure label present; style lint per language.
- Normalisation: NFKC, zero-width non-joiners, Arabic/Persian ye and kaf, Persian digits, Turkish case folding. Test vectors: `packages/schemas/fixtures/normalization.json` (shared with the SQL search function).
- Every result is stored as a Check, so a hold always has a reason. The gate can hold, never approve.
- Internal HTTP only, port 8102 in dev. Commands: `pnpm --filter @anr/verifier test|lint|typecheck|dev`.

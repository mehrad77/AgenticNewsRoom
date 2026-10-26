# anr-ingestion (Python)

Turns sources into stored leads: fetch → extract (raw page to R2) → deduplicate (canonical URL, content hash, near-duplicate text) → tier → store (frozen text) → summarise and tag (summariser agent, via a job). See `docs/technical-design.md#ingestion`.

- Internal HTTP only, called by TypeScript pg-boss jobs. Port 8101 in dev.
- Never fetch a source without `terms_checked`. Refuse private and internal addresses. A lead from an unknown site is tier 3.
- An agent's source request runs the same steps as a high-priority job and returns the lead.
- Commands: `pnpm --filter @anr/ingestion test|lint|typecheck|dev`.

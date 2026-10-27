# @anr/models

Calls models for the agents (D72). The router in `apps/agents/src/router.ts` decides which chain a role gets; this package calls the chain and reports which model answered.

- `catalog.ts`: loads `config/models.yaml`, or `models.<profile>.yaml` for `ANR_MODELS=<profile>`, and resolves keys from the env vars the file names. A model without its key is skipped, not an error.
- `gateway.ts`: `ModelGateway.chat({ chain, messages, tools, sticky })` tries the chain in order. Rate limits, outages, retired models and requests too large for one model (413) fall through to the next model; a bad key or a bad request throws `ModelCallFailed`; an exhausted chain throws `AllModelsExhausted`. Rate-limit state is in memory, per process.
- `errors.ts` sorts provider errors; `limits.ts` holds cooldowns and the published limits from the catalog.
- A provider may be a local OpenAI-compatible server (LM Studio, D84): loopback `http`, no `key_env`, a longer `timeout_s` (a matching undici fetch keeps Node's 300 s header timeout from cutting it short). Development profiles only.
- `adapters.ts` is the only file that knows LangChain's provider classes. OpenAI-compatible providers use Chat Completions only, so no built-in web tools can be reached (invariant 2).
- Never picks a model, never retries the same model, never decides what a failure means for the publication.
- Commands: `pnpm --filter @anr/models test`, `pnpm models:probe [free]` (real calls; never part of `pnpm check`).

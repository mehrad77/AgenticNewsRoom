# @anr/models

Calls models for the agents (D72). The router in `apps/agents/src/router.ts` decides which chain a role gets; this package calls the chain and reports which model answered.

- `catalog.ts`: loads `config/models.yaml`, or `models.<profile>.yaml` for `ANR_MODELS=<profile>`, and resolves keys from the env vars the file names. A model without its key is skipped, not an error.
- `gateway.ts`: `ModelGateway.chat({ chain, messages, tools, sticky })` tries the chain in order. Rate limits, outages, retired models and requests too large for one model (413) fall through to the next model; a bad key or a bad request throws `ModelCallFailed`; an exhausted chain throws `AllModelsExhausted`. Rate-limit state is in memory, per process.
- `errors.ts` sorts provider errors; an account out of credit (402, Anthropic's billing 400) counts as rate-limited for an hour, so the chain moves on. `limits.ts` holds cooldowns and the published limits from the catalog.
- `history.ts`: before a non-Anthropic model is called, Claude's thinking blocks are removed from the run's history (a fallback mid-run); Anthropic models get it unchanged.
- A provider may be a local OpenAI-compatible server (LM Studio, D84): loopback `http`, no `key_env`, a longer `timeout_s` (a matching undici fetch keeps Node's 300 s header timeout from cutting it short). Development profiles only.
- `adapters.ts` is the only file that knows LangChain's provider classes. OpenAI-compatible providers use Chat Completions only, so no built-in web tools can be reached (invariant 2). Anthropic (`kind: anthropic`) gets only the tools ANR binds, never its server tools; it is sent no temperature, top_p, top_k or thinking parameter (each is a 400), and a forced tool choice goes as `auto`.
- Never picks a model, never retries the same model, never decides what a failure means for the publication.
- Commands: `pnpm --filter @anr/models test`, `pnpm models:probe [free]` (real calls; never part of `pnpm check`).

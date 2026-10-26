# ANR — Agentic News Room

A platform for running publications where humans set the editorial direction, AI agents research and write, and code does everything mechanical. Each newsroom is a tenant with its own topic, languages, policy and channels. The first two are an AI newsroom (Persian and English) and Kültür, a Turkish culture newsroom (Turkish, English and Persian).

- Design: [`docs/`](docs/README.md), starting with the [charter](docs/charter.md).
- Working in the repo: [`AGENTS.md`](AGENTS.md) and [`docs/development.md`](docs/development.md).

## Quick start

Requires Node 24, pnpm 11, Python 3.13, uv and Docker.

```bash
pnpm install && uv sync
cp .env.example .env
pnpm db:up
pnpm check
pnpm dev
```

Then open http://ai.localhost:4321/ (Persian, right-to-left) and http://ai.localhost:4321/en.

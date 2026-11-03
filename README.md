# ANR — Agentic News Room

[![ci](https://github.com/mehrad77/AgenticNewsRoom/actions/workflows/ci.yml/badge.svg)](https://github.com/mehrad77/AgenticNewsRoom/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

A platform for running publications where humans set the editorial direction, AI agents research and write, and code does everything mechanical. Each newsroom is a tenant with its own topic, languages, policy and channels. The first two are an AI newsroom (Persian and English) and Kültür, a Turkish culture newsroom (Turkish, English and Persian).

**Live:** [ai.iranian.eu.org](https://ai.iranian.eu.org) · [kultur.iranian.eu.org](https://kultur.iranian.eu.org)

- Design: [`docs/`](docs/README.md), starting with the [charter](docs/charter.md).
- Working in the repo: [`AGENTS.md`](AGENTS.md) and [`docs/development.md`](docs/development.md).

## What it does

- **Source-grounded writing.** Agents have four tools and no web access: every factual claim cites a stored lead and a passage from its frozen text.
- **A gate that can only hold.** Code checks and a fact-checker from a different model family than the writer; any failed or uncertain check sends the publication to a person.
- **Only code publishes.** To the site, Telegram channels and podcast feeds, with AI disclosure on every channel and C2PA content credentials on audio.
- **Multilingual, right-to-left included.** Persian, Turkish and English sites from one codebase, routed by host.
- **Multi-tenant in the database.** Every tenant table has forced row-level security; a new newsroom is configuration only.
- **Operated like production.** Cloudflare Tunnel and Access, Terraform, SOPS, multi-arch images with SBOM and provenance attestations, OpenTelemetry with Grafana dashboards, SLO burn-rate alerts, load tests and chaos drills.

## Stack

TypeScript (Hono, Astro, LangGraph.js, pg-boss) and Python (FastAPI) in a pnpm + uv monorepo, on Postgres 17. See the [technical design](docs/technical-design.md).

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[GNU Affero General Public License v3.0](LICENSE). If you run a modified ANR as a service, you must offer its source to the people who use it.

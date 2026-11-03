# Contributing

Thanks for your interest in ANR. Issues and pull requests are welcome.

## Before you start

- Read the [charter](docs/charter.md). Its vocabulary is binding in code, data and conversation, and its invariants (listed in [`AGENTS.md`](AGENTS.md)) are not crossed by a code change: a change that needs to cross one starts as an issue proposing a charter change.
- For anything larger than a fix, open an issue first so the design can be settled before the code. `docs/` holds settled design only; open questions live in issues.
- A new newsroom is configuration only. If adding one seems to need code, the platform is missing a feature: propose it generically.

## Setting up

Follow the quick start in the [README](README.md) and [`docs/development.md`](docs/development.md). Each app, service and package has a short `AGENTS.md` describing its boundaries.

## Making a change

1. Branch from `main`.
2. Keep logic in plain modules with tests next to them; framework files stay thin.
3. Update `docs/` so it describes the result, and record new decisions in [`docs/decisions.md`](docs/decisions.md).
4. Run `pnpm check` (lint, typecheck, tests, config validation, codegen drift). It must pass; database tests need `pnpm db:up`.
5. Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(api): …`, `fix(verifier): …`, `docs: …`.
6. Open a pull request and fill in the template.

Never commit secrets: production settings live encrypted in `infra/secrets/` (SOPS), and channels are data in Postgres.

## Reporting bugs and security issues

Bugs go to [issues](https://github.com/mehrad77/AgenticNewsRoom/issues/new/choose). Security issues do not: see [SECURITY.md](SECURITY.md).

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [AGPL-3.0](LICENSE).

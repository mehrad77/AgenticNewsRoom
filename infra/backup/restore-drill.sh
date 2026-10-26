#!/usr/bin/env bash
# Milestone 7's gate, on a fresh machine with the repo, Docker and the production .env: restore the
# latest backup from R2, then run the tenancy check, config:check and config sync against it.
# Nothing is started besides Postgres, so nothing publishes from the restored copy.
source "$(dirname "$0")/lib.sh"
archive_off

compose() { docker compose --profile prod "$@"; }
compose build api
infra/backup/restore.sh
# --no-deps: otherwise compose may recreate Postgres from .env, with archiving on.
compose run --rm --no-deps migrate
compose run --rm --no-deps config-sync
assert_archive_off
echo "✓ restore drill passed: the latest backup restores and config loads into it"

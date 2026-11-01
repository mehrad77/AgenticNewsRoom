#!/usr/bin/env bash
# Milestone 7a's gate, on a fresh machine with the repo, Docker, sops and the operator's age key
# (from the password manager): restore the latest backup from R2, then run the tenancy check,
# config:check and config sync against it, in the tag's images.
#   infra/backup/restore-drill.sh <tag>
# Nothing besides Postgres and the two one-shot jobs starts, so nothing publishes from the copy.
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
# shellcheck source=../env.sh
source infra/env.sh
load_prod_env || die "could not load the production env"
archive_off
export ANR_VERSION="${1:-${ANR_VERSION:-}}"
[[ -n "$ANR_VERSION" ]] || die "usage: restore-drill.sh <tag>"

infra/backup/restore.sh
# --no-deps: otherwise compose may recreate Postgres; the jobs' images are pulled if missing.
docker compose run --rm --no-deps migrate
docker compose run --rm --no-deps config-sync
assert_archive_off
echo "✓ restore drill passed: the latest backup restores and config loads into it"

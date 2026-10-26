#!/usr/bin/env bash
# Rehearses disaster recovery on this machine, end to end, in its own Compose project:
#   1. a fresh database with the schema and config, archiving WAL to a local S3 stand-in
#   2. a full backup, then a write after it that only WAL replay can bring back
#   3. the database volume destroyed, then infra/backup/restore.sh into an empty one
#   4. restore-drill.sh as on a VM: tenancy, config:check and config sync against the copy, with
#      archiving kept off; then the write is back
# Needs Docker, pnpm and the dev .env. Leaves nothing behind unless ANR_DRILL_KEEP=1.
set -euo pipefail
cd "$(dirname "$0")/../.."

set -a
# shellcheck disable=SC1091
source .env
set +a
export COMPOSE_PROJECT_NAME=anr-drill
export COMPOSE_FILE=infra/compose.yaml:infra/backup/drill.compose.yaml
export COMPOSE_ENV_FILES=.env
export ANR_PG_PORT="${ANR_DRILL_PG_PORT:-5434}"
export ANR_DATABASES=anr
url() { echo "postgres://$1:$2@localhost:$ANR_PG_PORT/anr"; }
export DATABASE_URL DATABASE_MIGRATION_URL DATABASE_SYSTEM_URL
DATABASE_URL="$(url anr_app "$ANR_APP_DB_PASSWORD")"
DATABASE_MIGRATION_URL="$(url anr_migrator "$ANR_MIGRATOR_DB_PASSWORD")?sslmode=disable"
DATABASE_SYSTEM_URL="$(url anr_system "$ANR_SYSTEM_DB_PASSWORD")"

step() { printf '\n== %s\n' "$*"; }
psql_super() { docker compose exec -T postgres psql -U postgres -d anr -v ON_ERROR_STOP=1 -tA "$@"; }
cleanup() { [[ "${ANR_DRILL_KEEP:-}" == 1 ]] || docker compose down -v --remove-orphans >/dev/null 2>&1; }
trap cleanup EXIT
cleanup

step "1. fresh database archiving WAL to the S3 stand-in"
ANR_WAL_ARCHIVE=on docker compose up -d --build --wait s3 postgres
pnpm --silent --filter @anr/db exec env DATABASE_URL="$DATABASE_MIGRATION_URL" \
  dbmate --migrations-dir migrations --no-dump-schema up
pnpm --silent config:sync
# The stand-in takes a few seconds to accept connections.
for i in $(seq 1 15); do infra/backup/backup.sh init && break || { [[ $i == 15 ]] && exit 1; sleep 2; }; done

step "2. full backup, then a write only WAL replay can restore"
infra/backup/backup.sh full
marker="drill-$(date +%s)@example.invalid"
psql_super -c "insert into users (email) values ('$marker')"
# check switches to a new WAL segment and waits until it is archived.
infra/backup/backup.sh check
infra/backup/backup.sh info

step "3. lose the database; restore and load config as on a fresh VM"
docker compose rm -sf postgres
docker volume rm "${COMPOSE_PROJECT_NAME}_pgdata"
# As in production, where .env turns archiving on: the restore must keep it off regardless.
ANR_WAL_ARCHIVE=on infra/backup/restore-drill.sh

step "4. the write made after the backup"
[[ "$(psql_super -c "select count(*) from users where email = '$marker'")" == 1 ]] ||
  { echo "the write made after the backup is missing: WAL was not replayed" >&2; exit 1; }
echo "✓ it came back through WAL replay"
echo
echo "✓ drill passed: backup, WAL archive and restore work, and config loads into the restored database"

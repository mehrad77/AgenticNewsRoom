#!/usr/bin/env bash
# Rehearses disaster recovery on this machine, end to end, in its own Compose project (anr-drill)
# with the production Compose file and locally built images:
#   1. a fresh database with the schema and config, archiving WAL to a local S3 stand-in
#   2. a full backup, then a write after it that only WAL replay can bring back
#   3. the database volume destroyed, then restore-drill.sh as on a fresh machine: restore,
#      tenancy, config:check and config sync against the copy, with archiving kept off
#   4. the write is back
# Needs Docker, pnpm and the dev .env. Leaves nothing behind unless ANR_DRILL_KEEP=1.
set -euo pipefail
cd "$(dirname "$0")/../.."

# The drill's env: the dev .env with its own port, database list and URLs (never dev's database),
# and archiving on as in production, so the restore scripts must turn it off themselves.
work="$(mktemp -d)"
port="${ANR_DRILL_PG_PORT:-5434}"
set -a
# shellcheck disable=SC1091
source .env
set +a
# The dev Compose file's defaults, which a dev .env may leave out; the prod file has none.
: "${POSTGRES_PASSWORD:=postgres}" "${ANR_MIGRATOR_DB_PASSWORD:=anr_migrator}"
: "${ANR_APP_DB_PASSWORD:=anr_app}" "${ANR_SYSTEM_DB_PASSWORD:=anr_system}"
url() { echo "postgres://$1:$2@localhost:$port/anr"; }
{
  cat .env
  echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD"
  echo "ANR_MIGRATOR_DB_PASSWORD=$ANR_MIGRATOR_DB_PASSWORD"
  echo "ANR_APP_DB_PASSWORD=$ANR_APP_DB_PASSWORD"
  echo "ANR_SYSTEM_DB_PASSWORD=$ANR_SYSTEM_DB_PASSWORD"
  echo "ANR_PG_PORT=$port"
  echo "ANR_DATABASES=anr"
  echo "ANR_WAL_ARCHIVE=on"
  echo "DATABASE_URL=$(url anr_app "$ANR_APP_DB_PASSWORD")"
  echo "DATABASE_MIGRATION_URL=$(url anr_migrator "$ANR_MIGRATOR_DB_PASSWORD")?sslmode=disable"
  echo "DATABASE_SYSTEM_URL=$(url anr_system "$ANR_SYSTEM_DB_PASSWORD")"
} >"$work/drill.env"
export ANR_ENV_FILE="$work/drill.env"
set -a
# shellcheck disable=SC1090
source "$ANR_ENV_FILE"
set +a
export COMPOSE_PROJECT_NAME=anr-drill
export COMPOSE_FILE=infra/compose.prod.yaml:infra/compose.build.yaml:infra/backup/drill.compose.yaml
export ANR_IMAGES=local ANR_VERSION=local

step() { printf '\n== %s\n' "$*"; }
psql_super() { docker compose exec -T postgres psql -U postgres -d anr -v ON_ERROR_STOP=1 -tA "$@"; }
cleanup() {
  [[ "${ANR_DRILL_KEEP:-}" == 1 ]] || docker compose down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT
docker compose down -v --remove-orphans >/dev/null 2>&1

step "1. fresh database archiving WAL to the S3 stand-in"
docker compose build postgres api
docker compose up -d --wait s3 postgres
pnpm --silent --filter @anr/db exec env DATABASE_URL="$DATABASE_MIGRATION_URL" \
  dbmate --migrations-dir migrations --no-dump-schema up
pnpm --silent config:sync
# The stand-in takes a few seconds to accept connections.
for i in $(seq 1 15); do
  if infra/backup/backup.sh init; then break; fi
  [[ $i != 15 ]] || exit 1
  sleep 2
done

step "2. full backup, then a write only WAL replay can restore"
infra/backup/backup.sh full
marker="drill-$(date +%s)@example.invalid"
psql_super -c "insert into users (email) values ('$marker')"
# check switches to a new WAL segment and waits until it is archived.
infra/backup/backup.sh check
infra/backup/backup.sh info
[[ "$(psql_super -c "select count(*) from backup_runs where kind = 'check' and ok")" -ge 1 ]] ||
  { echo "the check wrote no backup_runs row (D131)" >&2; exit 1; }
echo "✓ every run is a backup_runs row"
# The desk's "check now" (D144): a request row, picked up by the host's job.
psql_super -c "insert into ops_requests (kind, requested_by) select 'backup-check', id from users where email = '$marker'" >/dev/null
infra/backup/backup.sh requests
[[ "$(psql_super -c "select count(*) from ops_requests r join backup_runs b on b.request_id = r.id where r.done_at is not null and b.ok")" == 1 ]] ||
  { echo "the desk's backup check was not run" >&2; exit 1; }
echo "✓ a check the desk asked for ran and was recorded"

step "3. lose the database; restore and load config as on a fresh machine"
docker compose rm -sf postgres
docker volume rm "${COMPOSE_PROJECT_NAME}_pgdata"
infra/backup/restore-drill.sh local

step "4. the write made after the backup"
[[ "$(psql_super -c "select count(*) from users where email = '$marker'")" == 1 ]] ||
  { echo "the write made after the backup is missing: WAL was not replayed" >&2; exit 1; }
echo "✓ it came back through WAL replay"
[[ "$(psql_super -c "select count(*) from restores")" -ge 1 ]] ||
  { echo "the restore was not recorded: the publisher would not hold past-due slots" >&2; exit 1; }
echo "✓ the restore is recorded, so past-due slots are held (D90)"
echo
echo "✓ drill passed: backup, WAL archive and restore work, and config loads into the restored database"

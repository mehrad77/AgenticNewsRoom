# shellcheck shell=bash
# Shared by the backup scripts. They act on the prod project (anr-prod) unless COMPOSE_PROJECT_NAME
# names another (the local drill's). Running jobs (backups, checks) reach Postgres with `docker exec`
# on the running container, so the host's scheduler needs no env and never recreates a container;
# the restore scripts use Compose with the env from infra/env.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-anr-prod}"
export COMPOSE_FILE="${COMPOSE_FILE:-infra/compose.prod.yaml}"

die() {
  echo "$(basename "$0"): $*" >&2
  exit 1
}
postgres_container() {
  local id
  id=$(docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --filter label=com.docker.compose.service=postgres)
  [[ -n "$id" ]] || die "no running postgres in project $COMPOSE_PROJECT_NAME"
  echo "$id"
}
pgbackrest() {
  docker exec -i --user postgres "$(postgres_container)" pgbackrest "$@"
}
psql_super() {
  docker exec -i "$(postgres_container)" psql -U postgres -v ON_ERROR_STOP=1 -tAq "$@"
}
# A restored copy must never archive into the production repository: that forks its history.
# Called at the start and end of every restore script.
archive_off() {
  export ANR_WAL_ARCHIVE=off
}
assert_archive_off() {
  [[ "$(psql_super -c 'show archive_mode')" == off ]] || die "the restored copy is archiving WAL; stop it now"
}

# Shared by the backup scripts. Compose reads COMPOSE_FILE, COMPOSE_PROJECT_NAME and
# COMPOSE_ENV_FILES itself, so the local drill points these scripts at its own project.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export COMPOSE_FILE="${COMPOSE_FILE:-infra/compose.yaml}"
export COMPOSE_ENV_FILES="${COMPOSE_ENV_FILES:-.env}"

pgbackrest() {
  docker compose exec -T --user postgres postgres pgbackrest "$@"
}
psql_super() {
  docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -tA "$@"
}
die() {
  echo "$(basename "$0"): $*" >&2
  exit 1
}
# A restored copy must never archive into the production repository: that forks its history.
# Called at the start and end of every restore script.
archive_off() {
  export ANR_WAL_ARCHIVE=off
}
assert_archive_off() {
  [[ "$(psql_super -c 'show archive_mode')" == off ]] || die "the restored copy is archiving WAL; stop it now"
}

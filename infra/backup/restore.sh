#!/usr/bin/env bash
# Restores the latest backup (and all archived WAL) into an empty Postgres volume, starts it
# with WAL archiving off, and waits until recovery has finished. Run on a fresh machine, from the
# repo root, with the production .env (the same role passwords, R2 keys and backup passphrase).
#   infra/backup/restore.sh                       latest state
#   ANR_RESTORE_TARGET="2026-11-02 09:00:00+03" infra/backup/restore.sh   point in time
source "$(dirname "$0")/lib.sh"
# Exported, so it beats ANR_WAL_ARCHIVE=on in the production .env for every compose call here.
archive_off

if [[ -n "$(docker compose ps --status running -q postgres)" ]]; then
  die "postgres is running; a restore needs it stopped and its volume empty"
fi

target=()
if [[ -n "${ANR_RESTORE_TARGET:-}" ]]; then
  target=(--type=time "--target=$ANR_RESTORE_TARGET" --target-action=promote)
fi
echo "restoring into an empty volume…"
# pgBackRest refuses a non-empty data directory, so an existing database is never overwritten.
docker compose run --rm --no-deps --user postgres --entrypoint pgbackrest postgres restore ${target[@]+"${target[@]}"}

docker compose up -d --wait postgres
echo "replaying WAL…"
for _ in $(seq 1 120); do
  if [[ "$(psql_super -c 'select pg_is_in_recovery()' 2>/dev/null)" == "f" ]]; then
    assert_archive_off
    echo "restored: $(psql_super -d anr -c "select count(*) || ' newsrooms' from newsrooms"), WAL archiving off"
    exit 0
  fi
  sleep 2
done
die "recovery did not finish within 4 minutes; see: docker compose logs postgres"

#!/usr/bin/env bash
# Backups with pgBackRest, run on the server from the repo root by the host profile's scheduler
# (infra/host/, D131) or by hand. Every run but `info` writes a backup_runs row.
#   infra/backup/backup.sh init         create the stanza in the bucket and check archiving
#   infra/backup/backup.sh full|diff|incr
#   infra/backup/backup.sh check        WAL archiving works (alert if this fails: WAL piles up)
#   infra/backup/backup.sh requests     run the checks the desk's Ops page asked for (D144)
#   infra/backup/backup.sh info         list backups and the WAL range
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

# One run, recorded with its kind, result and the end of its output; the exit status is pgBackRest's.
run() {
  local kind="$1" request="${2:-}" id output detail status=0
  id=$(psql_super -d anr -v kind="$kind" -v request="$request" <<'SQL'
insert into backup_runs (kind, request_id) values (:'kind', nullif(:'request', '')::uuid) returning id
SQL
  )
  case "$kind" in
    init) output=$({ pgbackrest stanza-create && pgbackrest check; } 2>&1) || status=$? ;;
    check) output=$(pgbackrest check 2>&1) || status=$? ;;
    *) output=$(pgbackrest backup --type="$kind" 2>&1) || status=$? ;;
  esac
  [[ -z "$output" ]] || printf '%s\n' "$output"
  detail="$output"
  ((${#detail} <= 2000)) || detail="${detail: -2000}"
  psql_super -d anr -v id="$id" -v ok="$([[ $status == 0 ]] && echo true || echo false)" \
    -v detail="$detail" <<'SQL'
update backup_runs set finished_at = now(), ok = :'ok', detail = nullif(:'detail', '') where id = :'id'
SQL
  return "$status"
}

# The desk's "check now" requests, oldest first; each is picked once, even with two runs at once.
requests() {
  local id
  while true; do
    id=$(psql_super -d anr <<'SQL'
update ops_requests set picked_at = now()
where id = (select id from ops_requests where picked_at is null and kind = 'backup-check'
            order by requested_at limit 1 for update skip locked)
returning id
SQL
    )
    [[ -n "$id" ]] || return 0
    run check "$id" || true
    psql_super -d anr -v id="$id" <<'SQL'
update ops_requests set done_at = now() where id = :'id'
SQL
  done
}

# A run the scheduler catches up at boot or on wake may start before Docker and Postgres are up.
wait_for_postgres() {
  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1 && docker exec "$(postgres_container 2>/dev/null)" \
      pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  die "postgres in $COMPOSE_PROJECT_NAME did not answer within 5 minutes"
}

case "${1:-}" in
  init | full | diff | incr | check) wait_for_postgres && run "$1" ;;
  requests) wait_for_postgres && requests ;;
  info) pgbackrest info ;;
  *) die "usage: backup.sh init|full|diff|incr|check|requests|info" ;;
esac

#!/usr/bin/env bash
# Backups with pgBackRest, run on the server from the repo root (cron, see infra/AGENTS.md).
#   infra/backup/backup.sh init         once: create the stanza in the bucket and check archiving
#   infra/backup/backup.sh full|diff|incr
#   infra/backup/backup.sh check        WAL archiving works (alert if this fails: WAL piles up)
#   infra/backup/backup.sh info         list backups and the WAL range
source "$(dirname "$0")/lib.sh"

case "${1:-}" in
  init)
    pgbackrest stanza-create
    pgbackrest check
    ;;
  full | diff | incr) pgbackrest backup --type="$1" ;;
  check) pgbackrest check ;;
  info) pgbackrest info ;;
  *) die "usage: backup.sh init|full|diff|incr|check|info" ;;
esac

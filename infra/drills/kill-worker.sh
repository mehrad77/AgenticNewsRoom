#!/usr/bin/env bash
# Chaos drill (D143): a worker that dies and stays down. `docker kill` counts as a manual stop, so
# the restart policy leaves it down until the drill starts it again. Runbook: kill-worker.md.
#   infra/drills/kill-worker.sh <project> [--prod] [service] [minutes]    default publisher, 7
set -euo pipefail
cd "$(dirname "$0")"
usage_rest="[service] [minutes]"
# shellcheck source=lib.sh
source ./lib.sh
parse_args "$@"
service="${args[0]:-publisher}"
minutes="${args[1]:-7}"
[[ "$minutes" =~ ^[0-9]+$ ]] || die "minutes must be a whole number"
# Workers with a heartbeat. The agents worker also reports every heartbeat's age, so killing it
# fires GaugesStale rather than HeartbeatLost.
case "$service" in api | web | agents | publisher | ingestion | verifier) ;; *) die "not a worker: $service" ;; esac
name=$(container "$project" "$service")
[[ -n "$name" && "$(docker inspect -f '{{.State.Running}}' "$name")" == true ]] ||
  die "$service is not running in $project"

restart() {
  docker start "$name" >/dev/null && say "started $service again"
}
trap restart EXIT
docker kill "$name" >/dev/null
say "killed $service in $project; starting it again in $minutes minutes (Ctrl-C does it now)"
hold "$minutes"

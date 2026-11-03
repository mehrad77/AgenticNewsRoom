#!/usr/bin/env bash
# Chaos drill (D143): a host outage, rehearsed by pausing every running container of a Compose
# project except its telemetry, which stays up to see it and alert. The real drill sleeps or stops
# the host instead (pause.md). Runbook: infra/drills/pause.md.
#   infra/drills/pause.sh <project> [--prod] [minutes]      default 15
set -euo pipefail
cd "$(dirname "$0")"
usage_rest="[minutes]"
# shellcheck source=lib.sh
source ./lib.sh
parse_args "$@"
minutes="${args[0]:-15}"
[[ "$minutes" =~ ^[0-9]+$ ]] || die "minutes must be a whole number"

paused=()
resume() {
  ((${#paused[@]} == 0)) || docker unpause "${paused[@]}" >/dev/null || true
  say "unpaused ${#paused[@]} containers of $project"
}
trap resume EXIT
while read -r name service; do
  case "$service" in lgtm | otel-collector) continue ;; esac
  docker pause "$name" >/dev/null
  paused+=("$name")
done < <(docker ps --filter "label=com.docker.compose.project=$project" --filter status=running \
  --format '{{.Names}} {{.Label "com.docker.compose.service"}}')
say "paused ${#paused[@]} containers of $project for $minutes minutes (Ctrl-C ends it early)"
hold "$minutes"

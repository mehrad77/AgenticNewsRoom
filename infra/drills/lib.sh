# shellcheck shell=bash
# Shared by the chaos drills (D143). Each drill takes the Compose project first; anr-prod also
# needs --prod, so a drill meant for a trial cannot hit production by a typo. Times are UTC, for the
# postmortem's timeline.

die() {
  echo "drill: $*" >&2
  exit 1
}
say() { echo "$(date -u +%H:%M:%SZ) $*"; }

# Sets project and args (the rest) from the command line.
parse_args() {
  local prod=0
  args=()
  for a in "$@"; do
    if [[ "$a" == --prod ]]; then prod=1; else args+=("$a"); fi
  done
  project="${args[0]:-}"
  [[ -n "$project" && "$project" != -* ]] || die "usage: $(basename "$0") <project> [--prod] ${usage_rest:-}"
  args=("${args[@]:1}")
  [[ "$project" != anr-prod || "$prod" == 1 ]] || die "anr-prod is production: add --prod"
  [[ -n "$(docker ps -q --filter "label=com.docker.compose.project=$project")" ]] ||
    die "no running containers in project $project"
}

# The container of a project's service.
container() {
  docker ps -a --filter "label=com.docker.compose.project=$1" \
    --filter "label=com.docker.compose.service=$2" --format '{{.Names}}' | head -1
}

# Ends the drill on Ctrl-C or a TERM, so its EXIT trap cleans up.
trap 'kill $(jobs -p) 2>/dev/null; exit 130' INT TERM

# Sleeps for the drill's length; in the background, so a signal ends it at once, not after.
hold() {
  sleep $(($1 * 60)) &
  wait $!
}

#!/usr/bin/env bash
# Chaos drill (D143, D153): fills a scratch volume, never Postgres's, until the disk with less free
# space is at the target, holds it there, then removes the volume. Real data, not fallocate: on
# macOS Docker's VM disk is a sparse file, so only written blocks take the host's disk; Docker gives
# them back seconds after the volume goes. Runbook: fill-disk.md.
#   infra/drills/fill-disk.sh <project> [--prod] [GB free] [minutes]    default 30, 10
set -euo pipefail
cd "$(dirname "$0")"
usage_rest="[GB free] [minutes]"
# shellcheck source=lib.sh
source ./lib.sh
parse_args "$@"
target="${args[0]:-30}"
minutes="${args[1]:-10}"
[[ "$target" =~ ^[0-9]+$ && "$minutes" =~ ^[0-9]+$ ]] || die "GB free and minutes must be whole numbers"
# Under DiskCritical's 20 GB, with room for whatever else writes meanwhile.
floor=25
((target >= floor)) || die "the target must be at least $floor GB free"

volume=anr-drill-fill
filler=anr-drill-fill
image=$(sed -n 's/^ *image: \(caddy:.*\)$/\1/p' ../compose.prod.yaml)
cleanup() {
  docker rm -f "$filler" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  say "removed the scratch volume"
}
trap cleanup EXIT
docker volume create "$volume" >/dev/null
docker run -d --name "$filler" --network none --entrypoint sleep -v "$volume:/fill" "$image" infinity >/dev/null

# Free GB (10^9 bytes, as the alerts count) on the volumes' disk and on the host's disk where the
# collector reads it (infra/observability); the drill fills whichever has less.
free_gb() {
  local volumes host
  volumes=$(docker exec "$filler" df -Pk /fill | awk 'NR == 2 { print $4 }')
  host=$(df -Pk ../observability | awk 'NR == 2 { print $4 }')
  ((volumes < host)) || volumes=$host
  echo $((volumes * 1024 / 1000000000))
}

free=$(free_gb)
say "$free GB free; filling to $target GB"
((free > target)) || die "already at or under $target GB free"
# A 1 GiB block of random bytes, copied: nothing on the way can skip or compress it.
docker exec "$filler" sh -c 'head -c 1073741824 /dev/urandom >/fill/block'
i=0
while ((free > target)); do
  ((free >= floor)) || die "under $floor GB free: stopping"
  i=$((i + 1))
  docker exec "$filler" cp /fill/block "/fill/$i"
  free=$(free_gb)
done
say "$free GB free after $((i + 1)) GiB; holding for $minutes minutes (Ctrl-C ends it early)"
hold "$minutes"

#!/usr/bin/env bash
# Runs the k6 load test of the reader sites (D142) in a container, results to Grafana over OTLP.
#   tools/load/run.sh dev                    dev's web (pnpm dev, :4321) and dev's telemetry stack
#   tools/load/run.sh <project> <root>       a Compose project's origin through its Caddy, e.g.
#                                            anr-prod iranian.eu.org; ask before running it on prod
# Env: RATE (20 a second), DURATION (2m), KINDS (home,publication,search,ninjs,feed).
# Hosts and podcast feeds come from config/newsrooms; the publications from the sites' home pages.
set -euo pipefail
cd "$(dirname "$0")/../.."

image=grafana/k6:1.4.2@sha256:3656673de3f30424e8ebcfa46acd9558d83b6a43612d0f668ffeac953950c6c7
usage() {
  echo "usage: tools/load/run.sh dev | <project> <root domain>" >&2
  exit 1
}
case "${1:-}" in
  "" | -*) usage ;;
  dev)
    root=localhost
    target=http://host.docker.internal:4321
    networks=(--network anr_default)
    ;;
  *)
    [[ -n "${2:-}" ]] || usage
    root="$2"
    target=http://caddy
    networks=(--network "$1_default" --network "$1_telemetry")
    ;;
esac

hosts=()
feeds=()
for dir in config/newsrooms/*/; do
  sub=$(sed -n 's/^subdomain: *\([a-z0-9-]*\).*/\1/p' "$dir/newsroom.yaml")
  hosts+=("$sub.$root")
  for series in "$dir"series/*.yaml; do
    grep -q '^format: *podcast-episode' "$series" && feeds+=("$sub.$root/podcast/$(basename "$series" .yaml).xml")
  done
done
join() { local IFS=,; echo "$*"; }

# k6's OpenTelemetry output: cumulative metrics prefixed k6_, so Prometheus takes them as counters
# and histograms like the apps' own.
docker run --rm -i "${networks[@]}" \
  -e TARGET="$target" -e HOSTS="$(join "${hosts[@]}")" -e FEEDS="$(join "${feeds[@]}")" \
  -e KINDS -e RATE -e DURATION \
  -e K6_OTEL_SERVICE_NAME=k6 -e K6_OTEL_METRIC_PREFIX=k6_ -e K6_OTEL_EXPORTER_TYPE=http \
  -e K6_OTEL_HTTP_EXPORTER_ENDPOINT=otel-collector:4318 -e K6_OTEL_HTTP_EXPORTER_INSECURE=true \
  -e K6_OTEL_FLUSH_INTERVAL=5s \
  "$image" run --out opentelemetry - <tools/load/reader.js

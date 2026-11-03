#!/usr/bin/env bash
# Sends the collector a span full of reader data, as an app that scrubs nothing would, and checks
# that Tempo keeps none of it (D137): no client address, user agent, header, query string, email,
# IP address or Telegram bot token. Runs a curl container on the project's network, so it needs no published port.
#   infra/observability/check-scrub.sh            dev (project anr, `pnpm telemetry:up`)
#   COMPOSE_PROJECT_NAME=anr-prod infra/observability/check-scrub.sh
set -euo pipefail
project="${COMPOSE_PROJECT_NAME:-anr}"
network="${project}_default"
curl_image="curlimages/curl:8.17.0@sha256:935d9100e9ba842cdb060de42472c7ca90cfe9a7c96e4dacb55e79e560b3ff40"
run() { docker run --rm --network "$1" "$curl_image" -fsS "${@:2}"; }

trace=$(openssl rand -hex 16)
span=$(openssl rand -hex 8)
now="$(date +%s)000000000"
attr() { printf '{"key":"%s","value":{"stringValue":"%s"}}' "$1" "$2"; }
attributes=$(
  IFS=,
  echo "$(attr client.address 203.0.113.7),$(attr net.peer.ip 203.0.113.7),$(attr user_agent.original Mozilla/5.0),$(attr http.request.header.cf-connecting-ip 203.0.113.7),$(attr url.full 'https://ai.example.org/challenge/1?k=secret-token'),$(attr url.query k=secret-token),$(attr http.route /challenge/:id),$(attr note 'from reader@example.org at 198.51.100.4'),$(attr url.path /bot123456:AAH-x_9kLmNoPqRsTuVwXyZ012/sendMessage)"
)
body='{"resourceSpans":[{"resource":{"attributes":['$(attr service.name scrub-check)']},"scopeSpans":[{"spans":[{"traceId":"'$trace'","spanId":"'$span'","name":"GET /challenge/:id","kind":2,"startTimeUnixNano":"'$now'","endTimeUnixNano":"'$now'","attributes":['$attributes']}]}]}]}'
run "$network" -X POST -H 'content-type: application/json' -d "$body" http://otel-collector:4318/v1/traces >/dev/null

# Tempo is reachable only on the telemetry network in production; dev's lgtm is on the default one.
tempo_network="${project}_telemetry"
docker network inspect "$tempo_network" >/dev/null 2>&1 || tempo_network="$network"
for _ in $(seq 1 30); do
  if stored=$(run "$tempo_network" "http://lgtm:3200/api/traces/$trace" 2>/dev/null); then break; fi
  sleep 2
done
[[ -n "${stored:-}" ]] || { echo "the test span never reached Tempo" >&2; exit 1; }
for leak in 203.0.113.7 198.51.100.4 Mozilla secret-token reader@example.org AAH-x_9kLmNoPq client.address \
  net.peer.ip user_agent cf-connecting-ip url.query; do
  if grep -q -- "$leak" <<<"$stored"; then
    echo "✗ Tempo kept '$leak'" >&2
    exit 1
  fi
done
grep -q 'https://ai.example.org/challenge/1"' <<<"$stored" || { echo "✗ url.full was not kept without its query" >&2; exit 1; }
echo "✓ the collector dropped every client address, user agent, header, query string, email, IP and bot token"

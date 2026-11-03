#!/usr/bin/env bash
# Checks the Prometheus rules generated from packages/telemetry/ops/rules.ts and runs their promtool
# tests (prometheus/tests/), with the promtool of the pinned otel-lgtm image. Needs Docker only.
#   infra/observability/check-rules.sh
set -euo pipefail
cd "$(dirname "$0")"
rules="$PWD/prometheus"
image=$(sed -n 's/^ *image: \(grafana\/otel-lgtm:[^ ]*\)$/\1/p' ../compose.prod.yaml | head -1)
promtool() {
  docker run --rm --entrypoint /otel-lgtm/prometheus/promtool -v "$rules:/rules:ro" \
    -w /rules/tests "$image" "$@"
}
promtool check rules /rules/rules/slo.yaml /rules/alerts/alerts.yaml
tests=(prometheus/tests/*.yaml)
promtool test rules "${tests[@]#prometheus/tests/}"

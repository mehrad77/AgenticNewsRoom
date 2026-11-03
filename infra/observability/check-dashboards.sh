#!/usr/bin/env bash
# Runs every panel query of the provisioned dashboards through Grafana's query API and fails on
# any error; prints how many series each returned, so a panel without data shows too. Against dev's
# Grafana (`pnpm telemetry:up`), whose anonymous viewer may query.
#   infra/observability/check-dashboards.sh [grafana url]
set -euo pipefail
cd "$(dirname "$0")"
GRAFANA="${1:-http://127.0.0.1:3000}" node --input-type=module - grafana/dashboards/*.json <<'EOF'
import { readFileSync } from "node:fs";
const grafana = process.env.GRAFANA;
let failed = 0;
for (const file of process.argv.slice(2)) {
  const dashboard = JSON.parse(readFileSync(file, "utf8"));
  for (const panel of dashboard.panels) {
    for (const target of panel.targets ?? []) {
      // The newsroom variable at "All".
      const expr = target.expr.replaceAll("$newsroom", ".+");
      const query = { ...target, expr, intervalMs: 60_000, maxDataPoints: 500 };
      const response = await fetch(`${grafana}/api/ds/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries: [query], from: "now-6h", to: "now" }),
      });
      const body = await response.json().catch(() => ({}));
      const result = body.results?.[target.refId];
      const error = result?.error ?? (response.ok ? undefined : `HTTP ${response.status}`);
      const series = result?.frames?.filter((f) => (f.data?.values?.[0]?.length ?? 0) > 0).length ?? 0;
      const name = `${dashboard.title} / ${panel.title} / ${target.refId}`;
      if (error) {
        failed = 1;
        console.log(`✗ ${name}: ${error}`);
      } else console.log(`${series > 0 ? "✓" : "·"} ${name}: ${series} series`);
    }
  }
}
process.exit(failed);
EOF

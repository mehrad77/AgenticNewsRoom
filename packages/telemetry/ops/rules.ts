// The SLOs and alerts of the technical design (D140, D158), written once. `ops/gen.ts` makes the
// Prometheus recording rules Prometheus loads, the Grafana-managed alert rules Grafana loads (otel-lgtm
// has no Alertmanager) and the same alerts as Prometheus rules for promtool's tests alone.

/** Slots on time: 95% over 28 days. */
export const SLOTS_OBJECTIVE = 0.95;
/** WAL archived: 99.5% of the minutes the server is up. */
export const WAL_OBJECTIVE = 0.995;
const WAL_BUDGET = 1 - WAL_OBJECTIVE;

export interface RecordingRule {
  record: string;
  expr: string;
}

const walRatio = (window: string): RecordingRule => ({
  record: `anr:wal_bad:ratio${window}`,
  // Minutes without a sample (the server down) are not in the average: "minutes the server is up".
  expr: `1 - max(avg_over_time(anr_wal_ok[${window}]))`,
});

export const RECORDING_RULES: readonly RecordingRule[] = [
  {
    record: "anr:slots:increase28d",
    expr: "sum by (anr_newsroom) (increase(anr_slots_total[28d]))",
  },
  {
    record: "anr:slots_bad:increase28d",
    expr: 'sum by (anr_newsroom) (increase(anr_slots_total{anr_slot_outcome=~"late|missed"}[28d]))',
  },
  {
    record: "anr:slots:budget_spent28d",
    expr: `(anr:slots_bad:increase28d / anr:slots:increase28d) / ${round(1 - SLOTS_OBJECTIVE)}`,
  },
  ...["5m", "30m", "1h", "6h", "28d"].map(walRatio),
  { record: "anr:wal:budget_spent28d", expr: `anr:wal_bad:ratio28d / ${round(WAL_BUDGET)}` },
];

export interface Alert {
  /** The alert's name, also its Grafana title. */
  name: string;
  /** PromQL that returns one series per firing instance, and nothing while all is well. */
  expr: string;
  /** How long it must hold before it fires. */
  for: string;
  severity: "critical" | "warning";
  summary: string;
}

const holds = (window: string) =>
  `sum by (anr_newsroom) (increase(anr_publications_holds_total[${window}]))`;
/** Days of hold data, up to 28: a newsroom's usual rate over the days it has, not over 28. */
const holdDays =
  "(max by (anr_newsroom) (count_over_time(anr_publications_holds_total[28d:1h])) / 24)";

export const ALERTS: readonly Alert[] = [
  {
    name: "SlotMissed",
    expr: 'sum by (anr_newsroom) (increase(anr_slots_total{anr_slot_outcome="missed"}[15m])) > 0',
    for: "0m",
    severity: "critical",
    summary: "{{ $labels.anr_newsroom }} missed a slot: see the desk's notices",
  },
  {
    name: "SlotsErrorBudgetHalfSpent",
    expr: "anr:slots:budget_spent28d >= 0.5",
    for: "0m",
    severity: "warning",
    summary: "{{ $labels.anr_newsroom }} has spent half its 28-day budget of late and missed slots",
  },
  {
    name: "WalArchiveBurnFast",
    expr: `anr:wal_bad:ratio1h > ${round(14.4 * WAL_BUDGET)} and anr:wal_bad:ratio5m > ${round(14.4 * WAL_BUDGET)}`,
    for: "2m",
    severity: "critical",
    summary: "WAL archiving burns its error budget 14.4 times too fast (1 h and 5 min)",
  },
  {
    name: "WalArchiveBurnSlow",
    expr: `anr:wal_bad:ratio6h > ${round(6 * WAL_BUDGET)} and anr:wal_bad:ratio30m > ${round(6 * WAL_BUDGET)}`,
    for: "15m",
    severity: "warning",
    summary: "WAL archiving burns its error budget 6 times too fast (6 h and 30 min)",
  },
  {
    name: "BackupCheckFailed",
    expr: 'max(anr_backup_last_ok{anr_backup_kind="check"}) == 0',
    for: "0m",
    severity: "critical",
    summary: "The latest backup check failed",
  },
  {
    name: "BackupCheckMissing",
    expr:
      'time() - max(anr_backup_last_success_seconds{anr_backup_kind="check"}) > 3600' +
      ' or (absent(anr_backup_last_success_seconds{anr_backup_kind="check"})' +
      " and on () count(anr_gauges_collected_seconds) > 0)",
    for: "5m",
    severity: "critical",
    summary: "No backup check has succeeded for an hour",
  },
  {
    name: "DiskLow",
    expr: 'min by (anr_disk) (system_filesystem_usage_bytes{state="free", anr_disk!=""}) < 40e9',
    for: "5m",
    severity: "warning",
    summary: "Under 40 GB free on the {{ $labels.anr_disk }} disk",
  },
  {
    name: "DiskCritical",
    expr: 'min by (anr_disk) (system_filesystem_usage_bytes{state="free", anr_disk!=""}) < 20e9',
    for: "5m",
    severity: "critical",
    summary: "Under 20 GB free on the {{ $labels.anr_disk }} disk",
  },
  {
    name: "HeartbeatLost",
    expr: "max by (anr_worker) (anr_heartbeat_age_seconds) > 180",
    // Not the minute after the host wakes, before the workers' first beats.
    for: "2m",
    severity: "critical",
    summary: "The {{ $labels.anr_worker }} worker has not beaten for over 3 minutes",
  },
  {
    name: "GaugesStale",
    expr: "time() - max(anr_gauges_collected_seconds) > 300 or absent(anr_gauges_collected_seconds)",
    for: "5m",
    severity: "critical",
    summary: "The agents worker has reported no platform gauges for 5 minutes",
  },
  {
    name: "NewsroomGaugesFailing",
    expr: "min by (anr_newsroom) (anr_gauges_newsroom_ok) == 0",
    for: "5m",
    severity: "critical",
    summary: "The gauges of {{ $labels.anr_newsroom }} cannot be read: its panels show old values",
  },
  {
    name: "TunnelDown",
    expr: "max(cloudflared_tunnel_ha_connections) < 1 or absent(cloudflared_tunnel_ha_connections)",
    for: "2m",
    severity: "critical",
    summary: "The Cloudflare Tunnel has no connection to Cloudflare's edge",
  },
  {
    name: "HoldRateSpike",
    expr: `${holds("24h")} > 2 * ${holds("28d")} / ${holdDays} and ${holds("24h")} >= 3 and ${holdDays} >= 7`,
    for: "0m",
    severity: "warning",
    summary: "{{ $labels.anr_newsroom }} held over twice its usual share of publications today",
  },
];

/** Thresholds as short decimals: 0.07200000000000001 → 0.072. */
function round(n: number): number {
  return Number(n.toPrecision(6));
}

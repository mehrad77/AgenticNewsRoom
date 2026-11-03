// Grafana dashboards as code (D139): `ops/gen.ts` writes each to infra/observability/grafana/
// dashboards/, which Grafana provisions read-only. Queries use the names Prometheus stores (OTLP
// names translated: dots to underscores, `_total` on counters, the unit as a suffix).

type Unit = "s" | "bytes" | "percentunit" | "currencyUSD" | "short" | "ops";

interface Query {
  expr: string;
  legend?: string;
  /** A table of the latest values rather than a series over time. */
  instant?: boolean;
}

interface Panel {
  type: "timeseries" | "stat" | "bargauge" | "table" | "alertlist" | "logs";
  title: string;
  width: number;
  height?: number;
  queries?: Query[];
  unit?: Unit;
  /** Values at or above each step turn its colour; the base is green. */
  steps?: { value: number; color: "orange" | "red" | "green" }[];
  /** Number → text, as for 0/1 gauges. */
  mappings?: Record<string, { text: string; color: string }>;
  bars?: boolean;
  loki?: string;
  /** Minimum interval of the panel's queries, for per-day increases. */
  interval?: string;
}

export interface Dashboard {
  uid: string;
  title: string;
  description: string;
  newsrooms?: boolean;
  panels: Panel[];
}

const PROMETHEUS = { type: "prometheus", uid: "prometheus" };
const LOKI = { type: "loki", uid: "loki" };
const NEWSROOM = 'anr_newsroom=~"$newsroom"';

const ts = (title: string, width: number, queries: Query[], extra: Partial<Panel> = {}): Panel => ({
  type: "timeseries",
  title,
  width,
  queries,
  ...extra,
});
const stat = (
  title: string,
  width: number,
  queries: Query[],
  extra: Partial<Panel> = {},
): Panel => ({
  type: "stat",
  title,
  width,
  queries: queries.map((q) => ({ instant: true, ...q })),
  ...extra,
});
const q = (expr: string, legend?: string): Query => (legend ? { expr, legend } : { expr });

const OPEN_DRAINED = {
  "0": { text: "open", color: "green" },
  "1": { text: "drained", color: "orange" },
};
const OK_FAILED = { "1": { text: "ok", color: "green" }, "0": { text: "failed", color: "red" } };

export const DASHBOARDS: readonly Dashboard[] = [
  {
    uid: "anr-overview",
    title: "Overview",
    description:
      "SLOs and error budgets, open alerts, heartbeats, the tunnel, the deployed version",
    newsrooms: true,
    panels: [
      stat(
        "Slots: error budget spent (28 days)",
        8,
        [q(`anr:slots:budget_spent28d{${NEWSROOM}}`, "{{anr_newsroom}}")],
        {
          unit: "percentunit",
          steps: [
            { value: 0.5, color: "orange" },
            { value: 1, color: "red" },
          ],
        },
      ),
      stat("WAL archived: error budget spent (28 days)", 8, [q("anr:wal:budget_spent28d")], {
        unit: "percentunit",
        steps: [
          { value: 0.5, color: "orange" },
          { value: 1, color: "red" },
        ],
      }),
      stat("Tunnel connections", 8, [q("max(cloudflared_tunnel_ha_connections)")], {
        steps: [
          { value: 0, color: "red" },
          { value: 1, color: "green" },
        ],
      }),
      { type: "alertlist", title: "Alerts", width: 12, height: 9 },
      {
        type: "bargauge",
        title: "Seconds since each worker's heartbeat",
        width: 12,
        height: 9,
        queries: [q("max by (anr_worker) (anr_heartbeat_age_seconds)", "{{anr_worker}}")].map(
          (x) => ({ ...x, instant: true }),
        ),
        unit: "s",
        steps: [
          { value: 60, color: "orange" },
          { value: 180, color: "red" },
        ],
      },
      {
        type: "table",
        title: "Deployed versions",
        width: 24,
        queries: [
          {
            expr: 'group by (service_name, service_version) (target_info{service_namespace="anr"})',
            instant: true,
          },
        ],
      },
    ],
  },
  {
    uid: "anr-queues",
    title: "Queues",
    description: "Depth, age of the oldest job, throughput and failures per pg-boss queue; drains",
    panels: [
      ts("Jobs ready", 12, [
        q(
          'max by (messaging_destination_name) (pgboss_queue_jobs{pgboss_job_state="ready"})',
          "{{messaging_destination_name}}",
        ),
      ]),
      ts(
        "Age of the oldest due job",
        12,
        [q("max by (anr_queue) (anr_queue_oldest_age_seconds) > 0", "{{anr_queue}}")],
        { unit: "s" },
      ),
      ts(
        "Jobs processed per second",
        12,
        [
          q(
            "sum by (messaging_destination_name) (rate(messaging_process_duration_seconds_count[5m]))",
            "{{messaging_destination_name}}",
          ),
        ],
        { unit: "ops" },
      ),
      ts(
        "Jobs failed per second",
        12,
        [
          q(
            'sum by (messaging_destination_name) (rate(messaging_process_duration_seconds_count{error_type!=""}[5m]))',
            "{{messaging_destination_name}}",
          ),
        ],
        { unit: "ops" },
      ),
      ts("Jobs active, deferred and failed", 12, [
        q(
          'max by (messaging_destination_name, pgboss_job_state) (pgboss_queue_jobs{pgboss_job_state=~"active|deferred|failed"})',
          "{{messaging_destination_name}} {{pgboss_job_state}}",
        ),
      ]),
      stat("Drains", 12, [q("max by (anr_queue) (anr_queue_drained)", "{{anr_queue}}")], {
        mappings: OPEN_DRAINED,
      }),
    ],
  },
  {
    uid: "anr-publishing",
    title: "Publishing",
    description: "Slots sent, late and missed per newsroom; holds and their reasons; hold rate",
    newsrooms: true,
    panels: [
      ts(
        "Slots per day",
        16,
        [
          q(
            `sum by (anr_newsroom, anr_slot_outcome) (increase(anr_slots_total{${NEWSROOM}}[1d]))`,
            "{{anr_newsroom}} {{anr_slot_outcome}}",
          ),
        ],
        { bars: true, interval: "1d" },
      ),
      stat(
        "Slots on time (28 days)",
        8,
        [
          q(
            `1 - anr:slots_bad:increase28d{${NEWSROOM}} / anr:slots:increase28d{${NEWSROOM}}`,
            "{{anr_newsroom}}",
          ),
        ],
        {
          unit: "percentunit",
          steps: [
            { value: 0, color: "red" },
            { value: 0.95, color: "green" },
          ],
        },
      ),
      ts(
        "Holds per day",
        12,
        [
          q(
            `sum by (anr_newsroom) (increase(anr_publications_holds_total{${NEWSROOM}}[1d]))`,
            "{{anr_newsroom}}",
          ),
        ],
        { bars: true, interval: "1d" },
      ),
      ts("Waiting for an editor", 12, [
        q(`max by (anr_newsroom) (anr_publications_with_editor{${NEWSROOM}})`, "{{anr_newsroom}}"),
      ]),
      {
        type: "bargauge",
        title: "Hold reasons (7 days)",
        width: 12,
        queries: [
          {
            expr: `sum by (anr_hold_reason) (increase(anr_publications_hold_reasons_total{${NEWSROOM}}[7d])) > 0`,
            legend: "{{anr_hold_reason}}",
            instant: true,
          },
        ],
      },
      ts("Hold rate: last 24 hours against the 28-day daily rate", 12, [
        q(
          `sum by (anr_newsroom) (increase(anr_publications_holds_total{${NEWSROOM}}[24h]))`,
          "{{anr_newsroom}} last 24 h",
        ),
        q(
          `sum by (anr_newsroom) (increase(anr_publications_holds_total{${NEWSROOM}}[28d])) / (max by (anr_newsroom) (count_over_time(anr_publications_holds_total{${NEWSROOM}}[28d:1h])) / 24)`,
          "{{anr_newsroom}} daily rate (up to 28 days)",
        ),
      ]),
    ],
  },
  {
    uid: "anr-agents",
    title: "Agents and spend",
    description: "Runs, tokens and cost per role and model; fallbacks; spend against each budget",
    newsrooms: true,
    panels: [
      {
        type: "bargauge",
        title: "Spend this month against the budget",
        width: 12,
        queries: [
          {
            expr: `max by (anr_newsroom) (anr_spend_month_usd{${NEWSROOM}}) / max by (anr_newsroom) (anr_budget_month_usd{${NEWSROOM}})`,
            legend: "{{anr_newsroom}}",
            instant: true,
          },
        ],
        unit: "percentunit",
        steps: [
          { value: 0.8, color: "orange" },
          { value: 1, color: "red" },
        ],
      },
      ts(
        "Spend this month",
        12,
        [q(`max by (anr_newsroom) (anr_spend_month_usd{${NEWSROOM}})`, "{{anr_newsroom}}")],
        { unit: "currencyUSD" },
      ),
      ts(
        "Runs per hour by role and outcome",
        12,
        [
          q(
            "sum by (gen_ai_agent_name, outcome) (increase(anr_agent_runs_total[1h]))",
            "{{gen_ai_agent_name}} {{outcome}}",
          ),
        ],
        { interval: "1h" },
      ),
      ts(
        "Cost per day by model",
        12,
        [
          q(
            "sum by (gen_ai_response_model) (increase(anr_gen_ai_cost_usd_total[1d]))",
            "{{gen_ai_response_model}}",
          ),
        ],
        { unit: "currencyUSD", bars: true, interval: "1d" },
      ),
      ts(
        "Tokens per hour by role",
        12,
        [
          q(
            "sum by (gen_ai_agent_name, gen_ai_token_type) (increase(gen_ai_client_token_usage_sum[1h]))",
            "{{gen_ai_agent_name}} {{gen_ai_token_type}}",
          ),
        ],
        { interval: "1h" },
      ),
      ts(
        "Model call latency, p95",
        12,
        [
          q(
            "histogram_quantile(0.95, sum by (le, gen_ai_request_model) (rate(gen_ai_client_operation_duration_seconds_bucket[15m])))",
            "{{gen_ai_request_model}}",
          ),
        ],
        { unit: "s" },
      ),
      ts(
        "Fallbacks per hour by reason",
        24,
        [
          q(
            "sum by (gen_ai_agent_name, outcome) (increase(anr_gen_ai_fallbacks_total[1h]))",
            "{{gen_ai_agent_name}} {{outcome}}",
          ),
        ],
        { interval: "1h" },
      ),
    ],
  },
  {
    uid: "anr-backups",
    title: "Backups and disk",
    description: "Backup runs, WAL archive age and failures, disk free, Postgres size",
    panels: [
      stat(
        "Latest backup run",
        8,
        [q("max by (anr_backup_kind) (anr_backup_last_ok)", "{{anr_backup_kind}}")],
        { mappings: OK_FAILED },
      ),
      stat(
        "Since the last successful run",
        8,
        [
          q(
            "time() - max by (anr_backup_kind) (anr_backup_last_success_seconds)",
            "{{anr_backup_kind}}",
          ),
        ],
        { unit: "s" },
      ),
      stat("Postgres size", 8, [q("max(anr_postgres_size_bytes)")], { unit: "bytes" }),
      ts(
        "Disk free",
        12,
        [
          q(
            'min by (anr_disk) (system_filesystem_usage_bytes{state="free", anr_disk!=""})',
            "{{anr_disk}}",
          ),
        ],
        {
          unit: "bytes",
          steps: [
            { value: 0, color: "red" },
            { value: 20e9, color: "orange" },
            { value: 40e9, color: "green" },
          ],
        },
      ),
      ts(
        "WAL: age of the last archived segment",
        12,
        [q("max(anr_wal_archive_age_seconds)", "age")],
        { unit: "s", steps: [{ value: 600, color: "red" }] },
      ),
      ts(
        "WAL archive failures per hour",
        12,
        [q("sum(increase(anr_wal_failed_total[1h]))", "failures")],
        { interval: "1h" },
      ),
      ts(
        "Memory used (on macOS, Docker's VM)",
        12,
        [q('max(system_memory_utilization_ratio{state="used"})', "used")],
        { unit: "percentunit" },
      ),
    ],
  },
  {
    uid: "anr-outages",
    title: "Outages",
    description: "Worker and host outages over time: sleep, reboots, crashes, restarts",
    panels: [
      ts(
        "Outages per day",
        12,
        [q("sum by (anr_outage_kind) (increase(anr_outages_total[1d]))", "{{anr_outage_kind}}")],
        { bars: true, interval: "1d" },
      ),
      ts(
        "Time in outages per day",
        12,
        [
          q(
            "sum by (anr_outage_kind) (increase(anr_outages_duration_seconds_total[1d]))",
            "{{anr_outage_kind}}",
          ),
        ],
        { unit: "s", bars: true, interval: "1d" },
      ),
      ts(
        "Seconds since each worker's heartbeat",
        24,
        [q("max by (anr_worker) (anr_heartbeat_age_seconds)", "{{anr_worker}}")],
        { unit: "s", steps: [{ value: 180, color: "red" }] },
      ),
      {
        type: "logs",
        title: "Workers starting and stopping",
        width: 24,
        height: 10,
        loki: '{service_namespace="anr"} |~ "worker started|signal|shutting down|outage"',
      },
    ],
  },
];

/** The dashboard as Grafana's JSON model. Panels flow left to right, 8 rows high unless set. */
export function toGrafana(d: Dashboard): Record<string, unknown> {
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  const panels = d.panels.map((p, i) => {
    const h = p.height ?? 8;
    if (x + p.width > 24) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    const gridPos = { x, y, w: p.width, h };
    x += p.width;
    rowHeight = Math.max(rowHeight, h);
    return panel(p, i + 1, gridPos);
  });
  return {
    uid: d.uid,
    title: d.title,
    description: d.description,
    tags: ["anr"],
    editable: false,
    graphTooltip: 1,
    schemaVersion: 41,
    time: { from: "now-7d", to: "now" },
    refresh: "1m",
    timezone: "browser",
    templating: {
      list: d.newsrooms
        ? [
            {
              name: "newsroom",
              label: "Newsroom",
              type: "query",
              datasource: PROMETHEUS,
              query: { query: "label_values(anr_slots_total, anr_newsroom)", refId: "newsrooms" },
              definition: "label_values(anr_slots_total, anr_newsroom)",
              refresh: 2,
              multi: true,
              includeAll: true,
              allValue: ".+",
              current: { selected: true, text: ["All"], value: ["$__all"] },
            },
          ]
        : [],
    },
    panels,
  };
}

function panel(p: Panel, id: number, gridPos: Record<string, number>): Record<string, unknown> {
  const base = { id, type: p.type, title: p.title, gridPos };
  if (p.type === "alertlist")
    return {
      ...base,
      options: {
        viewMode: "list",
        groupMode: "default",
        maxItems: 20,
        sortOrder: 1,
        stateFilter: { firing: true, pending: true, noData: true, error: true, normal: false },
        alertInstanceLabelFilter: "",
      },
    };
  if (p.type === "logs")
    return {
      ...base,
      datasource: LOKI,
      targets: [{ refId: "A", datasource: LOKI, expr: p.loki, queryType: "range" }],
      options: { showTime: true, wrapLogMessage: true, sortOrder: "Descending" },
    };
  const steps = [
    { color: "green", value: null },
    ...(p.steps ?? []).map((s) => ({ color: s.color, value: s.value })),
  ];
  const mappings = p.mappings
    ? [
        {
          type: "value",
          options: Object.fromEntries(
            Object.entries(p.mappings).map(([value, m], index) => [value, { ...m, index }]),
          ),
        },
      ]
    : [];
  return {
    ...base,
    datasource: PROMETHEUS,
    ...(p.interval ? { interval: p.interval } : {}),
    targets: (p.queries ?? []).map((query, i) => ({
      refId: String.fromCharCode(65 + i),
      datasource: PROMETHEUS,
      expr: query.expr,
      legendFormat: query.legend ?? "__auto",
      range: !query.instant,
      instant: Boolean(query.instant),
      ...(p.type === "table" ? { format: "table" } : {}),
    })),
    fieldConfig: {
      defaults: {
        unit: p.unit ?? "short",
        thresholds: { mode: "absolute", steps },
        mappings,
        ...(p.type === "timeseries"
          ? {
              custom: {
                drawStyle: p.bars ? "bars" : "line",
                fillOpacity: p.bars ? 80 : 10,
                showPoints: "never",
                ...(p.steps?.length ? { thresholdsStyle: { mode: "line" } } : {}),
              },
            }
          : {}),
      },
      overrides: [],
    },
    options:
      p.type === "timeseries"
        ? { legend: { displayMode: "list", placement: "bottom" }, tooltip: { mode: "multi" } }
        : p.type === "table"
          ? { showHeader: true }
          : {
              reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
              ...(p.type === "stat" ? { colorMode: "background", graphMode: "none" } : {}),
              ...(p.type === "bargauge"
                ? { displayMode: "gradient", orientation: "horizontal" }
                : {}),
            },
  };
}

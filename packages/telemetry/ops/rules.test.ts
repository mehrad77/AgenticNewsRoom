// Every alert has a promtool case where it fires (infra/observability/check-rules.sh runs them).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ALERTS } from "./rules.ts";

interface PromtoolTests {
  tests: { alert_rule_test?: { alertname: string; exp_alerts: unknown[] }[] }[];
}

const tests = parse(
  readFileSync(
    new URL("../../../infra/observability/prometheus/tests/alerts.test.yaml", import.meta.url),
    "utf8",
  ),
) as PromtoolTests;
const cases = tests.tests.flatMap((t) => t.alert_rule_test ?? []);

describe("alerts", () => {
  it.each(ALERTS.map((a) => a.name))("%s has a test where it fires", (name) => {
    expect(cases.some((c) => c.alertname === name && c.exp_alerts.length > 0)).toBe(true);
  });

  it("have unique names", () => {
    expect(new Set(ALERTS.map((a) => a.name)).size).toBe(ALERTS.length);
  });
});

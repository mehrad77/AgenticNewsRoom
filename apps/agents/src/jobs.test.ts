import { describe, expect, it } from "vitest";
import { registerJobs } from "./jobs.ts";

describe("registerJobs", () => {
  it("works only the queues it has handlers for", async () => {
    const queues: string[] = [];
    const work = (async (name: string) => queues.push(name)) as never;
    const noop = async () => {};
    await registerJobs({ work }, { "ingest-source": noop, "agent-run": noop, assign: noop });
    expect(queues).toEqual(["ingest-source", "assign", "agent-run"]);
    queues.length = 0;
    await registerJobs({ work }, { "ingest-source": noop });
    expect(queues).toEqual(["ingest-source"]);
  });
});

describe("registerJobs before", () => {
  it("runs the hook ahead of every job, on every queue", async () => {
    const workers = new Map<string, (jobs: { data: unknown }[]) => Promise<void>>();
    const work = (async (name: string, fn: (jobs: { data: unknown }[]) => Promise<void>) => {
      workers.set(name, fn);
    }) as never;
    const order: string[] = [];
    const handler = (name: string) => async (data: unknown) => {
      order.push(`${name}:${String(data)}`);
    };
    await registerJobs(
      { work },
      { gate: handler("gate"), "agent-run": handler("run") },
      async () => {
        order.push("before");
      },
    );
    await workers.get("agent-run")?.([{ data: 1 }, { data: 2 }]);
    await workers.get("gate")?.([{ data: 3 }]);
    expect(order).toEqual(["before", "run:1", "before", "run:2", "before", "gate:3"]);
  });
});

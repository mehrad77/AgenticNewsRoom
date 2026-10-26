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

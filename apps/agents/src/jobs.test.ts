import { describe, expect, it } from "vitest";
import { registerJobs } from "./jobs.ts";

describe("registerJobs", () => {
  it("subscribes to the agents worker's queues", async () => {
    const queues: string[] = [];
    await registerJobs({ work: (async (name: string) => queues.push(name)) as never });
    expect(queues).toEqual(["ingest-source", "assign", "agent-run"]);
  });
});

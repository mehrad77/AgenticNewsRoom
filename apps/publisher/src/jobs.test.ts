import { describe, expect, it } from "vitest";
import { registerJobs } from "./jobs.ts";

describe("registerJobs", () => {
  it("subscribes to the sweep, the subscriber snapshot and channel checks", async () => {
    const queues: string[] = [];
    await registerJobs({ work: (async (name: string) => queues.push(name)) as never });
    expect(queues).toEqual(["publish-sweep", "channel-stats", "channel-check"]);
  });
});

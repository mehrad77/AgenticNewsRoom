import { describe, expect, it } from "vitest";
import { registerJobs } from "./jobs.ts";

describe("registerJobs", () => {
  it("subscribes to the publisher's sweep", async () => {
    const queues: string[] = [];
    await registerJobs({ work: (async (name: string) => queues.push(name)) as never });
    expect(queues).toEqual(["publish-sweep"]);
  });
});

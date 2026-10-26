import { describe, expect, it } from "vitest";
import { createBoss } from "./boss.ts";
import { loadRootEnv, testDatabaseUrl } from "./testing.ts";

loadRootEnv();
const appUrl = testDatabaseUrl(process.env.DATABASE_URL ?? "");

describe("pg-boss", () => {
  it("runs as anr_app on the migrated schema with no DDL rights", async () => {
    const boss = createBoss(appUrl, "boss-test");
    await boss.start();
    try {
      // A pg-boss upgrade without a new migration fails here.
      const drift = await boss.detectSchemaDrift();
      expect(drift.ok).toBe(true);

      const queue = `test-${crypto.randomUUID().slice(0, 8)}`;
      await boss.createQueue(queue);
      const id = await boss.send(queue, { newsroomId: "n1" });
      const [job] = await boss.fetch<{ newsroomId: string }>(queue);
      expect(job?.id).toBe(id);
      expect(job?.data).toEqual({ newsroomId: "n1" });
      await boss.complete(queue, job?.id ?? "");
      await boss.deleteQueue(queue);
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});

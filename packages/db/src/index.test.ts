import { describe, expect, it } from "vitest";
import { createPool, type Pool, withNewsroom } from "./index.ts";

describe("createPool", () => {
  it("refuses to start without a connection string", () => {
    expect(() => createPool("")).toThrow("DATABASE_URL is not set");
  });
});

describe("withNewsroom", () => {
  it("rethrows the original error and destroys a client whose rollback fails", async () => {
    const released: unknown[] = [];
    const client = {
      query: async (sql: string) => {
        if (sql === "rollback") throw new Error("connection lost");
        return {};
      },
      release: (err?: unknown) => released.push(err),
    };
    const pool = { connect: async () => client } as unknown as Pool;
    await expect(
      withNewsroom(pool, "n1", async () => {
        throw new Error("original");
      }),
    ).rejects.toThrow("original");
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });
});

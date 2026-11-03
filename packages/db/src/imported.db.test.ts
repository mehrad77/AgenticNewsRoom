import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withNewsroom } from "./index.ts";
import { createTestNewsroom, testPools } from "./testing.ts";

// Only the legacy import, running as the system role, writes imported publications (D172,
// AGENTS.md invariant 3).
const pools = testPools();
let newsroom: string;
let series: string;

beforeAll(async () => {
  newsroom = await createTestNewsroom(pools.system, "imported");
  const { rows } = await pools.system.query<{ id: string }>(
    `insert into series (newsroom_id, slug, format_id, languages, config)
     select $1, 'daily', id, '{fa}', '{}' from formats limit 1 returning id`,
    [newsroom],
  );
  series = rows[0]?.id ?? "";
});
afterAll(() => pools.end());

const insert = (origin: string, slot: string) =>
  `insert into publications (newsroom_id, series_id, slot, language, status, origin)
   values ('${newsroom}', '${series}', '${slot}', 'fa', 'published', '${origin}') returning id`;

describe("imported publications", () => {
  it("are refused from the app role, and stay imported", async () => {
    await expect(
      withNewsroom(pools.app, newsroom, (c) => c.query(insert("imported", "2020-01-01T18:00Z"))),
    ).rejects.toThrow(/only the legacy import/);
    const { rows } = await pools.system.query<{ id: string }>(
      insert("imported", "2020-01-02T18:00Z"),
    );
    const id = rows[0]?.id;
    await expect(
      pools.system.query("update publications set origin = 'pipeline' where id = $1", [id]),
    ).rejects.toThrow(/stays imported/);
  });

  it("leave the pipeline's own publications alone", async () => {
    const { rows } = await withNewsroom(pools.app, newsroom, (c) =>
      c.query<{ id: string }>(insert("pipeline", "2020-01-03T18:00Z")),
    );
    expect(rows).toHaveLength(1);
    await expect(
      withNewsroom(pools.app, newsroom, (c) =>
        c.query("update publications set origin = 'imported' where id = $1", [rows[0]?.id]),
      ),
    ).rejects.toThrow(/only the legacy import/);
  });
});

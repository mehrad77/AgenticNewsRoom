import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { testPools } from "./testing.ts";

interface Vector {
  name: string;
  input: string;
  expected: string;
  language: string | null;
}
const require = createRequire(import.meta.url);
const { cases } = JSON.parse(
  readFileSync(require.resolve("@anr/schemas/fixtures/normalization.json"), "utf8"),
) as { cases: Vector[] };

const pools = testPools();
afterAll(() => pools.end());

describe("anr.normalize_text", () => {
  it.each(cases)("$name", async ({ input, expected, language }) => {
    const { rows } = await pools.app.query<{ out: string }>(
      "select anr.normalize_text($1, $2) as out",
      [input, language],
    );
    expect(rows[0]?.out).toBe(expected);
  });

  it("is immutable, so indexes can use it", async () => {
    const { rows } = await pools.app.query<{ v: string }>(
      "select provolatile as v from pg_proc where oid = 'anr.normalize_text(text, text)'::regprocedure",
    );
    expect(rows[0]?.v).toBe("i");
  });
});

import { describe, expect, it } from "vitest";
import { listSchemas, loadSchema } from "./catalog.ts";

describe("schema catalog", () => {
  it("lists config and format schemas", () => {
    const ids = listSchemas().map((s) => s.id);
    expect(ids).toContain("config/newsroom");
    expect(ids).toContain("format/newsletter-issue");
    expect(ids.some((id) => id.startsWith("format/_"))).toBe(false);
  });

  it("inlines $refs", async () => {
    const schema = await loadSchema("config/models");
    expect(JSON.stringify(schema)).not.toContain("$ref");
  });

  it("returns undefined for an unknown id", async () => {
    expect(await loadSchema("config/nope")).toBeUndefined();
  });
});

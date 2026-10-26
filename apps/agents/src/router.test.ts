import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ModelRouter } from "./router.ts";

const router = ModelRouter.fromFile(
  fileURLToPath(new URL("../../../config/models.yaml", import.meta.url)),
);

describe("ModelRouter", () => {
  it("uses the format override for the desk", () => {
    const def = router.resolve("desk");
    const newsletter = router.resolve("desk", { format: "newsletter-issue" });
    expect(newsletter.model).not.toBe(def.model);
  });

  it("never lets the writer's model check its own facts", () => {
    for (const format of [undefined, "newsletter-issue", "classic-article"]) {
      const writer = router.resolve("desk", { format });
      const checker = router.resolve("fact-checker", { writerModel: writer.model });
      expect(checker.model).not.toBe(writer.model);
    }
  });

  it("refuses a fact-check without the writer's model", () => {
    expect(() => router.resolve("fact-checker")).toThrow();
  });
});

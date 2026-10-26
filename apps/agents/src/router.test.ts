import { fileURLToPath } from "node:url";
import { modelsFile } from "@anr/models";
import { describe, expect, it } from "vitest";
import { ModelRouter } from "./router.ts";

const configDir = fileURLToPath(new URL("../../../config", import.meta.url));
const formats = [undefined, "newsletter-issue", "classic-article"];

for (const profile of ["", "free"]) {
  const router = ModelRouter.fromFile(modelsFile(configDir, profile));

  describe(`ModelRouter (${profile || "models.yaml"})`, () => {
    it("never lets a model family that wrote the story check it", () => {
      for (const format of formats) {
        // Any model in the desk chain may have answered, after fallbacks.
        for (const writer of router.resolve("desk", { format })) {
          const writerFamilies = [router.family(writer)];
          const checkers = router.resolve("fact-checker", { writerFamilies });
          expect(checkers.length).toBeGreaterThan(0);
          for (const c of checkers) expect(router.family(c)).not.toBe(writerFamilies[0]);
        }
      }
    });

    it("refuses a fact-check without the writer's families", () => {
      expect(() => router.resolve("fact-checker")).toThrow();
      expect(() => router.resolve("fact-checker", { writerFamilies: [] })).toThrow();
    });

    it("throws when every fact-checker family wrote the story", () => {
      const all = router.resolve("fact-checker", { writerFamilies: ["none"] });
      const writerFamilies = all.map((id) => router.family(id));
      expect(() => router.resolve("fact-checker", { writerFamilies })).toThrow(
        /no fact-checker model/,
      );
    });
  });
}

describe("ModelRouter (models.free.yaml)", () => {
  const router = ModelRouter.fromFile(modelsFile(configDir, "free"));

  it("skips the same weights served by another provider", () => {
    const checkers = router.resolve("fact-checker", { writerFamilies: ["gpt-oss-120b"] });
    expect(checkers).not.toContain("groq-gpt-oss-120b");
    expect(checkers).not.toContain("cloudflare-gpt-oss-120b");
  });
});

describe("ModelRouter (models.yaml)", () => {
  const router = ModelRouter.fromFile(modelsFile(configDir, ""));

  it("uses the format override for the desk", () => {
    expect(router.resolve("desk", { format: "newsletter-issue" })).not.toEqual(
      router.resolve("desk"),
    );
  });
});

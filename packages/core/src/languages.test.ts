import { describe, expect, it } from "vitest";
import { directionOf, isLanguage } from "./languages.ts";

describe("directionOf", () => {
  it("is right-to-left for Persian only", () => {
    expect(directionOf("fa")).toBe("rtl");
    expect(directionOf("en")).toBe("ltr");
    expect(directionOf("tr")).toBe("ltr");
  });
});

describe("isLanguage", () => {
  it("accepts v1 languages and rejects others", () => {
    expect(isLanguage("tr")).toBe(true);
    expect(isLanguage("de")).toBe(false);
  });
});

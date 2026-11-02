import { describe, expect, it } from "vitest";
import { telegramChat } from "./channels.ts";

describe("telegramChat", () => {
  it("keeps numeric chat ids", () => {
    expect(telegramChat("-1001234567890")).toBe("-1001234567890");
    expect(telegramChat(" 42 ")).toBe("42");
  });

  it("turns a channel name, typed any way, into @name", () => {
    for (const raw of [
      "singularity_takinegi",
      "@singularity_takinegi",
      "https://t.me/singularity_takinegi",
      "t.me/singularity_takinegi",
    ]) {
      expect(telegramChat(raw)).toBe("@singularity_takinegi");
    }
  });

  it("refuses what Telegram cannot resolve", () => {
    for (const raw of ["", "ab", "has space", "9lives", "https://example.com/x"]) {
      expect(telegramChat(raw)).toBeNull();
    }
  });
});

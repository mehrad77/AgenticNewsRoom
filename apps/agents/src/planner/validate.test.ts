import { describe, expect, it } from "vitest";
import { cycleWeeks, validateCandidates, validateThemes } from "./validate.ts";

const lead = "3f1c2b8e-6a4d-4c1e-9b7a-2d5e8f0a1b2c";
const weeks = cycleWeeks({ starts: "2026-11-01", ends: "2026-12-01" });

const theme = (name: string) => ({
  theme: name,
  angle: "Who builds open models, and who can check them.",
  rationale: "Releases doubled in the pool.",
  calendar: weeks.map((week) => ({ week, focus: `focus ${week}` })),
  lead_ids: [lead],
});
const candidate = (title: string) => ({
  title,
  angle: "The paper and what came of it.",
  why: "It fits the theme.",
  lead_ids: [lead],
});

describe("planner validation (D103)", () => {
  it("keys a month's calendar by the Mondays of the weeks it touches", () => {
    expect(weeks).toEqual([
      "2026-10-26",
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
      "2026-11-23",
      "2026-11-30",
    ]);
  });

  it("takes two or three themes covering exactly the cycle's weeks", () => {
    expect(validateThemes({ themes: [theme("a"), theme("b")] }, weeks)).toHaveLength(2);
    expect(validateThemes({ themes: [theme("a")] }, weeks)).toEqual([
      "themes: Too small: expected array to have >=2 items",
    ]);
    const short = { ...theme("b"), calendar: theme("b").calendar.slice(1) };
    expect(validateThemes({ themes: [theme("a"), short] }, weeks)).toEqual([
      `themes.1.calendar: give exactly these weeks, in order: ${weeks.join(", ")}`,
    ]);
  });

  it("requires stored lead ids behind every proposal", () => {
    const bare = { ...theme("a"), lead_ids: [] };
    expect(validateThemes({ themes: [bare, theme("b")] }, weeks)).toContain(
      "themes.0.lead_ids: Too small: expected array to have >=1 items",
    );
    const made = { ...candidate("x"), lead_ids: ["not-a-uuid"] };
    const errors = validateCandidates({ candidates: [made, candidate("y"), candidate("z")] });
    expect(errors[0]).toMatch(/^candidates\.0\.lead_ids\.0: /);
  });

  it("takes exactly three different candidates", () => {
    expect(validateCandidates({ candidates: [candidate("x"), candidate("y")] })).toEqual([
      "candidates: Too small: expected array to have exactly 3 items",
    ]);
    expect(
      validateCandidates({ candidates: [candidate("x"), candidate("X"), candidate("y")] }),
    ).toEqual(["candidates: the three must differ"]);
    expect(
      validateCandidates({ candidates: [candidate("x"), candidate("y"), candidate("z")] }),
    ).toHaveLength(3);
  });
});

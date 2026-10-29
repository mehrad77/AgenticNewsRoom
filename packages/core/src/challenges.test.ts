import { describe, expect, it } from "vitest";
import { challengeDeadlines, challengeSteps } from "./challenges.ts";

describe("challenge deadlines", () => {
  it("acknowledges within 24 hours and answers within 48, reminding 6 hours before each", () => {
    const d = challengeDeadlines(new Date("2026-11-02T10:00:00Z"));
    expect(d).toEqual({
      acknowledgeBy: new Date("2026-11-03T10:00:00Z"),
      answerBy: new Date("2026-11-04T10:00:00Z"),
    });
    expect(challengeSteps(d).map((s) => [s.step, s.at, s.when.toISOString()])).toEqual([
      ["acknowledge", "due", "2026-11-03T04:00:00.000Z"],
      ["acknowledge", "overdue", "2026-11-03T10:00:00.000Z"],
      ["answer", "due", "2026-11-04T04:00:00.000Z"],
      ["answer", "overdue", "2026-11-04T10:00:00.000Z"],
    ]);
  });
});

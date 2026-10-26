import { describe, expect, it } from "vitest";
import { cronDaily, cronEvery, newsroomSchedules } from "./schedules.ts";

describe("cronEvery", () => {
  it.each([
    ["15m", "*/15 * * * *"],
    ["1h", "0 */1 * * *"],
    ["6h", "0 */6 * * *"],
    ["24h", "0 0 * * *"],
    ["1d", "0 0 * * *"],
  ])("%s -> %s", (every, cron) => expect(cronEvery(every)).toBe(cron));

  it.each(["45m", "5h", "2d", "0h"])("refuses %s, which cron cannot repeat evenly", (every) => {
    expect(() => cronEvery(every)).toThrow("must divide");
  });
});

describe("newsroomSchedules", () => {
  const sources = [
    { id: "s1", every: "1h", terms_checked: "2026-10-01" },
    { id: "s2", every: "1h" },
    { id: "s3", every: "24h", terms_checked: "2026-10-01", use: "enrichment" },
  ];
  const series = [
    { id: "daily", cadence: { daily: "21:00" }, assignment_at: "16:00" },
    { id: "weekly", cadence: { weekly: "wed 10:00" } },
  ];
  const schedules = newsroomSchedules("n1", "Europe/Istanbul", sources, series);

  it("schedules only sources whose terms a person has checked (D17)", () => {
    expect(schedules.filter((s) => s.queue === "ingest-source").map((s) => s.key)).toEqual(["s1"]);
  });

  it("assigns daily news at assignment_at in the newsroom's timezone", () => {
    expect(schedules.find((s) => s.queue === "assign")).toEqual({
      queue: "assign",
      key: "daily",
      cron: cronDaily("16:00"),
      tz: "Europe/Istanbul",
      data: { newsroomId: "n1", seriesId: "daily" },
      missed: "once",
    });
    expect(cronDaily("16:00")).toBe("0 16 * * *");
  });
});

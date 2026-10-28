import { describe, expect, it } from "vitest";
import { cronDaily, cronEvery, cronWeekly, newsroomSchedules } from "./schedules.ts";

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

describe("cronDaily", () => {
  it("maps a time of day", () => expect(cronDaily("08:05")).toBe("5 8 * * *"));

  it.each(["24:30", "12:60", "8:00"])("refuses %s", (time) => {
    expect(() => cronDaily(time)).toThrow("must be 00:00 to 23:59");
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
    { id: "episode", cadence: { weekly: "fri 18:00" }, assignment_at: "fri 08:00" },
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

  it("assigns a weekly episode at its weekday and time, and a picked series never by schedule", () => {
    const assigns = schedules.filter((s) => s.queue === "assign");
    expect(assigns.map((s) => [s.key, s.cron])).toEqual([
      ["daily", "0 16 * * *"],
      ["episode", "0 8 * * 5"],
    ]);
  });

  it("runs one planning tick a day per newsroom, catching up once after downtime", () => {
    expect(schedules.filter((s) => s.queue === "plan")).toEqual([
      {
        queue: "plan",
        key: "n1",
        cron: "0 6 * * *",
        tz: "Europe/Istanbul",
        data: { newsroomId: "n1" },
        missed: "once",
      },
    ]);
  });
});

describe("cronWeekly", () => {
  it("maps a weekday and time", () => expect(cronWeekly("sun 23:30")).toBe("30 23 * * 0"));
  it("rejects a bare time", () => expect(() => cronWeekly("08:00")).toThrow("weekday"));
});

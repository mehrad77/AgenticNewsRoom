import { describe, expect, it } from "vitest";
import {
  cycleContaining,
  cycleStart,
  cycleToPlan,
  localDay,
  localInstant,
  nextCycle,
  nextWeekly,
  pickWindow,
  weekdayOf,
} from "./planning.ts";

const monthly = { cycle: "1mo", from: "2026-11-01" };
const IST = "Europe/Istanbul";

describe("cycles", () => {
  it("runs calendar months back to back", () => {
    expect(cycleStart(monthly, 0)).toBe("2026-11-01");
    expect(cycleStart(monthly, 2)).toBe("2027-01-01");
    expect(cycleContaining(monthly, "2026-11-30")).toEqual({
      starts: "2026-11-01",
      ends: "2026-12-01",
    });
    expect(cycleContaining(monthly, "2026-10-31")).toBeNull();
  });

  it("clamps a month cycle from the 31st to each month's last day", () => {
    const p = { cycle: "1mo", from: "2027-01-31" };
    expect(cycleStart(p, 1)).toBe("2027-02-28");
    expect(cycleStart(p, 2)).toBe("2027-03-31");
  });

  it("counts day and week cycles from their first day", () => {
    expect(cycleContaining({ cycle: "10d", from: "2026-11-01" }, "2026-11-25")).toEqual({
      starts: "2026-11-21",
      ends: "2026-12-01",
    });
    expect(cycleContaining({ cycle: "2w", from: "2026-11-02" }, "2026-11-16")).toEqual({
      starts: "2026-11-16",
      ends: "2026-11-30",
    });
  });

  it("plans the next cycle within a week of its start, else the current one", () => {
    expect(nextCycle(monthly, "2026-10-28")).toEqual({ starts: "2026-11-01", ends: "2026-12-01" });
    expect(cycleToPlan(monthly, "2026-10-28")?.starts).toBe("2026-11-01");
    expect(cycleToPlan(monthly, "2026-11-10")?.starts).toBe("2026-11-01");
    expect(cycleToPlan(monthly, "2026-11-24")?.starts).toBe("2026-12-01");
    expect(cycleToPlan(monthly, "2026-10-01")).toBeNull();
  });
});

describe("local time", () => {
  it("converts local wall time to an instant", () => {
    expect(localInstant("2026-11-04", "10:00", IST).toISOString()).toBe("2026-11-04T07:00:00.000Z");
    // Across a daylight-saving change (Berlin leaves summer time on 2026-10-25).
    expect(localInstant("2026-10-24", "12:00", "Europe/Berlin").toISOString()).toBe(
      "2026-10-24T10:00:00.000Z",
    );
    expect(localInstant("2026-10-26", "12:00", "Europe/Berlin").toISOString()).toBe(
      "2026-10-26T11:00:00.000Z",
    );
    expect(localDay(new Date("2026-11-03T22:30:00Z"), IST)).toBe("2026-11-04");
    expect(weekdayOf("2026-11-02")).toBe("mon");
  });

  it("finds the next weekly time, the same day when it is still ahead", () => {
    const fri = new Date("2026-11-06T05:00:00Z"); // 08:00 Friday in Istanbul
    expect(nextWeekly("fri 18:00", fri, IST).toISOString()).toBe("2026-11-06T15:00:00.000Z");
    const late = new Date("2026-11-06T16:00:00Z");
    expect(nextWeekly("fri 18:00", late, IST).toISOString()).toBe("2026-11-13T15:00:00.000Z");
  });
});

describe("pick windows", () => {
  const pick = { by: "mon", editor_picks_by: "tue" } as const;

  it("proposes Monday, closes at the end of Tuesday, publishes Wednesday", () => {
    for (const day of ["2026-11-02", "2026-11-03"]) {
      const w = pickWindow(pick, "wed 10:00", day, IST);
      expect(w?.week).toBe("2026-11-02");
      expect(w?.deadline.toISOString()).toBe("2026-11-03T21:00:00.000Z");
      expect(w?.slot.toISOString()).toBe("2026-11-04T07:00:00.000Z");
    }
  });

  it("is closed between the deadline and the next proposal day", () => {
    expect(pickWindow(pick, "wed 10:00", "2026-11-04", IST)).toBeNull();
    expect(pickWindow(pick, "wed 10:00", "2026-11-08", IST)).toBeNull();
  });

  it("publishes a Thursday series in the same week", () => {
    const w = pickWindow(pick, "thu 12:00", "2026-11-02", IST);
    expect(w?.slot.toISOString()).toBe("2026-11-05T09:00:00.000Z");
  });
});

import { describe, it, expect } from "vitest";
import { enumerateNights } from "./capacity";

const utcDay = (d: string) => {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
};

describe("enumerateNights", () => {
  it("keeps only the selected weekdays", () => {
    const nights = enumerateNights("2026-09-01", {
      weekdays: new Set([2]), // Tuesday
      slotTimes: ["19:00"],
      endDate: "2026-09-30",
    });
    expect(nights.length).toBeGreaterThan(0);
    for (const n of nights) expect(utcDay(n.date)).toBe(2);
  });

  it("excludes skip dates", () => {
    const opts = {
      weekdays: new Set([2]),
      slotTimes: ["19:00"],
      endDate: "2026-09-30",
    };
    const all = enumerateNights("2026-09-01", opts);
    const skip = all[1].date;
    const nights = enumerateNights("2026-09-01", {
      ...opts,
      excluded: new Set([skip]),
    });
    expect(nights.map((n) => n.date)).not.toContain(skip);
    expect(nights.length).toBe(all.length - 1);
  });

  it("stops at endDate inclusive", () => {
    const nights = enumerateNights("2026-09-01", {
      weekdays: new Set([0, 1, 2, 3, 4, 5, 6]),
      slotTimes: ["19:00"],
      endDate: "2026-09-05",
    });
    expect(nights[0].date).toBe("2026-09-01");
    expect(nights.at(-1)!.date).toBe("2026-09-05");
    expect(nights.length).toBe(5);
  });

  it("caps at maxNights and carries the slot list", () => {
    const nights = enumerateNights("2026-09-01", {
      weekdays: new Set([0, 1, 2, 3, 4, 5, 6]),
      slotTimes: ["19:00", "20:15"],
      maxNights: 3,
    });
    expect(nights.length).toBe(3);
    for (const n of nights) expect(n.slots).toEqual(["19:00", "20:15"]);
  });

  it("is UTC-stable across a DST boundary", () => {
    // US DST starts 2026-03-08; a Tuesday filter must stay Tuesdays.
    const nights = enumerateNights("2026-03-01", {
      weekdays: new Set([2]),
      slotTimes: ["19:00"],
      endDate: "2026-03-31",
    });
    expect(nights.length).toBe(5);
    for (const n of nights) expect(utcDay(n.date)).toBe(2);
  });
});

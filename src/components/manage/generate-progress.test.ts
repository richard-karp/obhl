import { describe, it, expect } from "vitest";
import { generateProgress } from "./generate-progress";
import { estimatedGenerateMs } from "@/lib/schedule/assignNights";

const EXPECTED = 26_500;

describe("generateProgress", () => {
  it("starts empty with the whole estimate left", () => {
    const p = generateProgress(0, EXPECTED);
    expect(p.fraction).toBe(0);
    expect(p.remainingSec).toBe(27); // ceil — never counts down before a second passes
    expect(p.overrun).toBe(false);
  });

  it("advances proportionally through the run", () => {
    expect(generateProgress(EXPECTED / 2, EXPECTED).fraction).toBeCloseTo(0.5);
    expect(generateProgress(EXPECTED / 4, EXPECTED).fraction).toBeCloseTo(0.25);
  });

  it("counts the remaining seconds down", () => {
    expect(generateProgress(EXPECTED - 10_000, EXPECTED).remainingSec).toBe(10);
    expect(generateProgress(EXPECTED - 500, EXPECTED).remainingSec).toBe(1);
  });

  it("caps the bar short of full while work is still in flight", () => {
    // The whole point of the cap: at 99% of the estimate the bar must not read
    // as finished, because the server hasn't answered yet.
    expect(generateProgress(EXPECTED * 0.99, EXPECTED).fraction).toBe(0.95);
    expect(generateProgress(EXPECTED * 10, EXPECTED).fraction).toBe(0.95);
  });

  it("flags overrun at the estimate and stops the countdown at zero", () => {
    const at = generateProgress(EXPECTED, EXPECTED);
    expect(at.overrun).toBe(true);
    expect(at.remainingSec).toBe(0);

    const past = generateProgress(EXPECTED + 60_000, EXPECTED);
    expect(past.overrun).toBe(true);
    expect(past.remainingSec).toBe(0);
  });

  it("treats a non-positive estimate as unknown rather than dividing by zero", () => {
    for (const bad of [0, -1, Number.NaN]) {
      const p = generateProgress(1_000, bad);
      expect(Number.isFinite(p.fraction)).toBe(true);
      expect(p.fraction).toBe(0.95);
      expect(p.remainingSec).toBe(0);
      expect(p.overrun).toBe(true);
    }
  });

  it("clamps a negative elapsed instead of running the bar backwards", () => {
    const p = generateProgress(-5_000, EXPECTED);
    expect(p.fraction).toBe(0);
    expect(p.remainingSec).toBe(27);
  });
});

describe("estimatedGenerateMs", () => {
  // Not pinned to a number: the point of computing it from SLOT_CANDIDATES is
  // that adding a candidate moves it. Bound it to the range the indicator's
  // copy makes sense in instead.
  it("is a positive estimate in the tens of seconds", () => {
    const ms = estimatedGenerateMs();
    expect(ms).toBeGreaterThan(5_000);
    expect(ms).toBeLessThan(120_000);
  });

  it("produces a countdown that starts full and ends at overrun", () => {
    const ms = estimatedGenerateMs();
    expect(generateProgress(0, ms).overrun).toBe(false);
    expect(generateProgress(ms, ms).overrun).toBe(true);
  });
});

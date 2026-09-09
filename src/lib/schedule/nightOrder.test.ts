import { describe, it, expect } from "vitest";
import { improveNightOrder } from "./nightOrder";

describe("improveNightOrder", () => {
  const ok = (cost: number) => ({ cost, admissible: true });

  it("returns a permutation of every night", () => {
    const order = improveNightOrder(9, (o) => ok(o.indexOf(0)));
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("finds an order the scorer prefers", () => {
    // Wants night 8 first; the identity costs 8, the optimum costs 0.
    const order = improveNightOrder(9, (o) => ok(o.indexOf(8)));
    expect(order[0]).toBe(8);
  });

  it("keeps the identity when nothing can beat it", () => {
    const order = improveNightOrder(9, () => ok(0));
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("never returns an order the scorer called inadmissible", () => {
    // Only orders starting at night 3 are admissible; the rest are cheaper, so
    // a search that ignored `admissible` would settle on one of them.
    const order = improveNightOrder(9, (o) => ({
      cost: o[0] === 3 ? 10 : 0,
      admissible: o[0] === 3,
    }));
    expect(order[0]).toBe(3);
  });

  it("is deterministic for a given seed", () => {
    const s = (o: number[]) => ok(o.indexOf(5) * 10 + o.indexOf(2));
    expect(improveNightOrder(12, s, { seed: 7 })).toEqual(
      improveNightOrder(12, s, { seed: 7 }),
    );
  });
});

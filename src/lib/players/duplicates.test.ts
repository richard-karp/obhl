import { describe, it, expect } from "vitest";
import { findDuplicateClusters, type DuplicateCandidate } from "./duplicates";

const row = (o: Partial<DuplicateCandidate> & { playerId: string }): DuplicateCandidate => ({
  firstName: "Mike", lastName: "Smith", seasonId: "s1", teamId: "t1",
  teamName: "Sharks", jerseyNumber: 17, position: "F", ...o,
});

describe("findDuplicateClusters", () => {
  it("groups the same name across different teams", () => {
    const out = findDuplicateClusters([
      row({ playerId: "a", teamId: "t1", teamName: "Sharks" }),
      row({ playerId: "b", teamId: "t2", teamName: "Bears" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].members.map((m) => m.playerId).sort()).toEqual(["a", "b"]);
  });

  it("ignores case, punctuation and extra whitespace", () => {
    const out = findDuplicateClusters([
      row({ playerId: "a", firstName: "Mike", lastName: "O'Brien" }),
      row({ playerId: "b", firstName: " mike ", lastName: "obrien" }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("returns no cluster for a unique name", () => {
    expect(findDuplicateClusters([row({ playerId: "a" })])).toEqual([]);
  });

  it("does not cluster one player appearing twice under one id", () => {
    const out = findDuplicateClusters([
      row({ playerId: "a", teamId: "t1" }),
      row({ playerId: "a", teamId: "t2" }),
    ]);
    expect(out).toEqual([]);
  });

  it("drops a pair the operator dismissed as different people", () => {
    const out = findDuplicateClusters(
      [row({ playerId: "a" }), row({ playerId: "b" })],
      [["a", "b"]],
    );
    expect(out).toEqual([]);
  });

  it("matches a dismissed pair given in either order", () => {
    // 0035 stores player_a < player_b. A literal comparison here would make
    // every dismissal a silent no-op in one direction.
    const out = findDuplicateClusters(
      [row({ playerId: "b" }), row({ playerId: "a" })],
      [["b", "a"]],
    );
    expect(out).toEqual([]);
  });

  it("still clusters a third record when only one pair was dismissed", () => {
    const out = findDuplicateClusters(
      [row({ playerId: "a" }), row({ playerId: "b" }), row({ playerId: "c" })],
      [["a", "b"]],
    );
    expect(out).toHaveLength(1);
    expect(out[0].members).toHaveLength(3);
  });
});

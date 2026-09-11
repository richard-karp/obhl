import { describe, it, expect } from "vitest";
import { suggestGoalie, type RosterGoalie } from "./suggest";

const g = (
  playerId: string,
  number: number | null,
  night: number | null,
): RosterGoalie => ({ playerId, number, night });

describe("suggestGoalie", () => {
  it("picks the team's only goalie whatever night it is", () => {
    // ⚠️ EVEN WHEN THEIR NIGHT DOES NOT MATCH. "If there is only one goalie
    // then they are the goalie" is the rule the maintainer gave, so a Monday
    // goalie is still the suggestion for a Thursday game.
    expect(suggestGoalie([g("a", 1, 1)], 4)).toBe("a");
    expect(suggestGoalie([g("a", 1, null)], 4)).toBe("a");
  });

  it("picks the goalie assigned to the game's night", () => {
    const two = [g("a", 1, 1), g("b", 30, 4)];
    expect(suggestGoalie(two, 1)).toBe("a");
    expect(suggestGoalie(two, 4)).toBe("b");
  });

  it("picks nobody when two share a team and neither owns the night", () => {
    expect(suggestGoalie([g("a", 1, 1), g("b", 30, 4)], 2)).toBeNull();
    expect(suggestGoalie([g("a", 1, null), g("b", 30, null)], 2)).toBeNull();
  });

  it("breaks a shared night by the lower jersey, deterministically", () => {
    // Two goalies may share a night — there is no uniqueness constraint, on
    // purpose, because a team that alternates must be representable. What must
    // not happen is the suggestion changing between reads of the same data.
    expect(suggestGoalie([g("b", 30, 4), g("a", 1, 4)], 4)).toBe("a");
    expect(suggestGoalie([g("a", 1, 4), g("b", 30, 4)], 4)).toBe("a");
  });

  it("orders two unnumbered goalies stably, in either argument order", () => {
    // ⛔ THE CASE THE COMPARATOR EXISTS FOR, AND IT WAS MISSING. The sort was
    // `(a.number ?? Infinity) - (b.number ?? Infinity)`, which is `NaN` only
    // when BOTH are unnumbered — one unnumbered goalie (below) never tripped
    // it, so reverting the fix still passed the suite. Unnumbered players are
    // real: the esportsdesk parser produced a whole league of them.
    const both = [g("b", null, 4), g("a", null, 4)];
    const picked = suggestGoalie(both, 4);
    expect(picked).not.toBeNull();
    // Same answer whichever order they arrive in — that is what "stable" has
    // to mean here, since the caller's row order is a database detail.
    expect(suggestGoalie([...both].reverse(), 4)).toBe(picked);
  });

  it("sorts an absent number last rather than first", () => {
    // A goalie with no jersey must not win the tiebreak by sorting as 0.
    expect(suggestGoalie([g("a", null, 4), g("b", 30, 4)], 4)).toBe("b");
  });

  it("picks nobody with no goalie, or an unusable date", () => {
    expect(suggestGoalie([], 4)).toBeNull();
    // `leagueWeekday` returns -1 for a game with no date, which must match no
    // assignment rather than falling through to somebody.
    expect(suggestGoalie([g("a", 1, 1), g("b", 30, 4)], -1)).toBeNull();
  });
});

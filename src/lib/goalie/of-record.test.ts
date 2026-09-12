import { describe, it, expect } from "vitest";
import { resolveGoalieOfRecord, goalieLine, type SideInput } from "./of-record";

const side = (over: Partial<SideInput> = {}): SideInput => ({
  goalieId: null,
  goalieIsSub: false,
  dressedGoalieIds: [],
  ...over,
});

// Canonical lowercase uuids, deliberately ordered so that the "lowest id"
// branch cannot pass by accident of array order: `hi` is listed FIRST in every
// fixture that uses both.
const LO = "11111111-1111-4111-8111-111111111111";
const HI = "99999999-9999-4999-8999-999999999999";

describe("resolveGoalieOfRecord", () => {
  it("credits the explicit pick over a dressed goalie", () => {
    expect(
      resolveGoalieOfRecord(side({ goalieId: "pick", dressedGoalieIds: [LO] })),
    ).toEqual({ kind: "player", playerId: "pick" });
  });

  it("credits the dressed goalie when nobody was picked", () => {
    expect(resolveGoalieOfRecord(side({ dressedGoalieIds: [LO] }))).toEqual({
      kind: "player",
      playerId: LO,
    });
  });

  it("takes the lowest id when a team dressed two goalies", () => {
    // ⛔ THIS MIRRORS THE DATABASE, NOT A PREFERENCE. `v_goalie_stats`' fallback
    // is `distinct on (game_id, team_id) … order by … gr.player_id`, so
    // Postgres keeps the lowest uuid. A different tie-break here would credit
    // the box score to one goalie and /stats to the other.
    expect(resolveGoalieOfRecord(side({ dressedGoalieIds: [HI, LO] }))).toEqual(
      { kind: "player", playerId: LO },
    );
  });

  it("does not mutate the caller's array while sorting", () => {
    const dressedGoalieIds = [HI, LO];
    resolveGoalieOfRecord(side({ dressedGoalieIds }));
    expect(dressedGoalieIds).toEqual([HI, LO]);
  });

  /**
   * ⛔ THE TWO TESTS BELOW ARE THE POINT OF THE THREE-VALUE RETURN, and each
   * would still pass if `sub` and `none` were the same value — so they assert
   * the exact kind rather than "not a player". Collapsing them is what the
   * finalize guard cannot survive: `sub` is a complete answer a scorekeeper
   * gave, `none` is nobody having answered, and only `none` is a problem.
   */
  it("reports a substitute as `sub`, not as a missing goalie", () => {
    expect(resolveGoalieOfRecord(side({ goalieIsSub: true }))).toEqual({
      kind: "sub",
    });
  });

  it("reports `none` when nothing was recorded and nobody was dressed", () => {
    expect(resolveGoalieOfRecord(side())).toEqual({ kind: "none" });
  });

  it("lets the sub flag suppress the dressed fallback", () => {
    // `0015`: a rostered goalie who dressed as an unused backup must never be
    // charged for the game the substitute played.
    expect(
      resolveGoalieOfRecord(
        side({ goalieIsSub: true, dressedGoalieIds: [LO] }),
      ),
    ).toEqual({ kind: "sub" });
  });
});

describe("goalieLine", () => {
  const line = (over: Parameters<typeof goalieLine>[0]) => goalieLine(over);

  it("subtracts empty-net goals from the goals against", () => {
    expect(
      line({
        ...side({ goalieId: "g" }),
        goalsAgainst: 5,
        emptyNetAgainst: 2,
        outcome: "L",
      }),
    ).toEqual({ playerId: "g", ga: 3, shutout: false, outcome: "L" });
  });

  it("floors the goals against at zero", () => {
    // Nothing constrains the empty-net count against the score, so a miscount
    // must not hand a goalie a negative GA.
    expect(
      line({
        ...side({ goalieId: "g" }),
        goalsAgainst: 1,
        emptyNetAgainst: 3,
        outcome: "L",
      })?.ga,
    ).toBe(0);
  });

  it("calls a 3-0 loss to three empty-netters a shutout", () => {
    // ⛔ THE CASE THAT SEPARATES `ga === 0` FROM `score === 0`. The goalie was
    // not beaten; the team still lost. `v_goalie_stats` counts the shutout.
    expect(
      line({
        ...side({ goalieId: "g" }),
        goalsAgainst: 3,
        emptyNetAgainst: 3,
        outcome: "L",
      }),
    ).toEqual({ playerId: "g", ga: 0, shutout: true, outcome: "L" });
  });

  it("is not a shutout when a goal beat the goalie", () => {
    expect(
      line({
        ...side({ goalieId: "g" }),
        goalsAgainst: 3,
        emptyNetAgainst: 2,
        outcome: "W",
      })?.shutout,
    ).toBe(false);
  });

  it("has no line for a substitute or for nobody", () => {
    const stats = {
      goalsAgainst: 4,
      emptyNetAgainst: 0,
      outcome: "L",
    } as const;
    expect(line({ ...side({ goalieIsSub: true }), ...stats })).toBeNull();
    expect(line({ ...side(), ...stats })).toBeNull();
  });
});

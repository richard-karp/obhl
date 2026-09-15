/**
 * ⛔ A second copy of `v_goalie_stats`' rule (`0044`, `goalie_appearances`), which has no pointer
 * back here: change both, or the box score and /stats credit different goalies.
 */

export type SideInput = {
  /** `games.{home,away}_goalie_id` — the explicit pick, or null. */
  goalieId: string | null;
  /** `games.{home,away}_goalie_is_sub`. */
  goalieIsSub: boolean;
  /** Dressed player ids for this team whose roster row is `position = 'G'`: the fallback pool. */
  dressedGoalieIds: string[];
};

/**
 * ⛔ Three kinds, never folded into `goalie | null`: `sub` is a complete answer (`0015`) and
 * only `none` is a problem, which is all the finalize guard asks.
 */
export type GoalieRecord =
  { kind: "player"; playerId: string } | { kind: "sub" } | { kind: "none" };

export function resolveGoalieOfRecord(side: SideInput): GoalieRecord {
  // The view's three branches, in its order. 1. An explicit pick wins unless the side is
  // flagged sub, matching the SQL's `and not home_goalie_is_sub`.
  if (side.goalieId !== null && !side.goalieIsSub) {
    return { kind: "player", playerId: side.goalieId };
  }

  // 2. Flagged sub: no record, and ⛔ the dressed fallback is suppressed, or a rostered
  //    backup who dressed unused is charged for the substitute's game (`0015`).
  if (side.goalieIsSub) return { kind: "sub" };

  // 3. No pick: the dressed goalie. ⛔ Lowest id, as the view's `distinct on … order by player_id`
  //    keeps (uuid text order is byte order); never lowest jersey, which is `suggestGoalie`'s tiebreak.
  const [lowest] = [...side.dressedGoalieIds].sort();
  return lowest ? { kind: "player", playerId: lowest } : { kind: "none" };
}

export type GoalieLine = {
  playerId: string;
  /** Goals against, empty-netters excluded, floored at 0. */
  ga: number;
  shutout: boolean;
  outcome: "W" | "L" | "T";
};

/**
 * The box-score line, once the game has a result. Null unless an individual
 * carries the record — a `sub` or `none` side has no line to draw.
 */
export function goalieLine(
  side: SideInput & {
    /** Goals this team conceded — i.e. the OPPONENT's score. */
    goalsAgainst: number;
    /** `games.{home,away}_empty_net_against` for THIS team. */
    emptyNetAgainst: number;
    outcome: "W" | "L" | "T";
  },
): GoalieLine | null {
  const record = resolveGoalieOfRecord(side);
  if (record.kind !== "player") return null;

  // ⛔ `greatest(0, …)` in the view: empty-net goals are not constrained against the score, so a
  // miscount must not hand a goalie a negative GA.
  const ga = Math.max(0, side.goalsAgainst - side.emptyNetAgainst);

  return {
    playerId: record.playerId,
    ga,
    // ⛔ A shutout is `ga === 0`, not `goalsAgainst === 0`: a 3-0 loss on three empty-netters is
    // one, and the view credits it.
    shutout: ga === 0,
    outcome: side.outcome,
  };
}

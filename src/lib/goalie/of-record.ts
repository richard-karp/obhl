/**
 * Who carries a team's goaltending record for ONE game, and what their line is.
 *
 * ⛔ THIS IS THE SECOND COPY OF A RULE THAT ALSO LIVES IN SQL. `v_goalie_stats`
 * (current definition: `supabase/migrations/0044_team_logo_in_stats_views.sql`,
 * `goalie_appearances`) decides the same thing for the season leaderboards. The
 * two must agree, and a change to either is a change to both — a box score that
 * credits a different goalie from the one on `/stats` is worse than either
 * answer alone.
 *
 * ⚠️ AND THE SQL SIDE CARRIES NO POINTER BACK HERE. Adding one means a
 * migration, which is not worth a comment; so this is the asymmetry to know
 * about rather than one to fix. A view is the right home for this rule if it
 * ever gains a third consumer — see the plan under
 * `docs/superpowers/plans/2026-09-12-stats-logos-schedule-tabs-and-goalie-box.md`
 * for why it was not worth a deploy window for the second.
 *
 * ⛔ TWO FUNCTIONS, BECAUSE TWO CALLERS ASK DIFFERENT QUESTIONS. The box score
 * has a finished game and wants a stat line. The scoresheet's finalize guard
 * asks BEFORE there is a result, and only wants to know whether anybody was
 * recorded at all. Folding them into one `goalie | null` collapses *"a
 * substitute played"* into the same answer as *"nobody entered this"* — and
 * that distinction is the whole of the guard: a Sub is a complete, deliberate
 * answer (`0015`: a substitute goalie has no individual record on purpose), so
 * warning about it would nag a correctly-entered sheet. A warning that fires on
 * correct data is how people learn to click through warnings.
 */

export type SideInput = {
  /** `games.{home,away}_goalie_id` — the explicit pick, or null. */
  goalieId: string | null;
  /** `games.{home,away}_goalie_is_sub`. */
  goalieIsSub: boolean;
  /**
   * Player ids dressed for this team in this game whose roster row is
   * `position = 'G'`. The fallback pool, and nothing else.
   */
  dressedGoalieIds: string[];
};

/**
 * Identity only — no game result needed.
 *
 * - `player` — an individual carries the record.
 * - `sub`    — a substitute played: recorded, but no individual credit.
 * - `none`   — nothing was recorded at all. This is the only one that is a
 *              problem, and the only one the finalize guard warns about.
 */
export type GoalieRecord =
  { kind: "player"; playerId: string } | { kind: "sub" } | { kind: "none" };

export function resolveGoalieOfRecord(side: SideInput): GoalieRecord {
  // The view's three branches, in the view's order.

  // 1. An explicit pick wins — but only when the side is not flagged sub.
  //    ⚠️ `setGoalie` never writes both (`goalie_id` is nulled when "sub" is
  //    tapped), so the order of these two tests cannot matter today. It is
  //    written to match the SQL anyway, because the SQL's `and not
  //    home_goalie_is_sub` is doing exactly this and a reader comparing them
  //    should not have to prove the equivalence.
  if (side.goalieId !== null && !side.goalieIsSub) {
    return { kind: "player", playerId: side.goalieId };
  }

  // 2. Flagged sub: no individual record, AND the dressed fallback is
  //    suppressed. ⛔ BOTH HALVES. `0015` added the flag precisely so a
  //    rostered goalie who dressed as an unused backup is never charged for a
  //    game the substitute played; falling through to the pool here would
  //    charge them.
  if (side.goalieIsSub) return { kind: "sub" };

  // 3. No pick: the dressed goalie.
  //    ⛔ LOWEST ID WINS, AND THAT IS NOT ARBITRARY HERE EVEN THOUGH IT LOOKS
  //    IT. The view's fallback is `distinct on (gr.game_id, gr.team_id) …
  //    order by gr.game_id, gr.team_id, gr.player_id`, so Postgres keeps the
  //    lowest `player_id` when a team dressed two. Sorting the ids as strings
  //    reproduces that: Postgres orders `uuid` by its 16 bytes, and canonical
  //    lowercase hex with hyphens at fixed positions sorts identically as text.
  //    ⚠️ Do not "improve" this to lowest jersey — `suggestGoalie` breaks ITS
  //    tie that way, but this one has to match the database, not the
  //    suggestion.
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

  // ⛔ `greatest(0, …)` IN THE VIEW, `Math.max(0, …)` HERE. Empty-net goals are
  // counted per team and nothing constrains them against the score, so a
  // miscount must not hand a goalie a negative GA.
  const ga = Math.max(0, side.goalsAgainst - side.emptyNetAgainst);

  return {
    playerId: record.playerId,
    ga,
    // ⛔ A SHUTOUT IS `ga === 0`, NOT `goalsAgainst === 0`. A team that loses
    // 3-0 on three empty-net goals has a goalie who was not beaten, and the
    // view credits the shutout. The two tests agree on most games and disagree
    // on exactly the one worth getting right.
    shutout: ga === 0,
    outcome: side.outcome,
  };
}

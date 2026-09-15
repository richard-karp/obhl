import { createClient } from "@/utils/supabase/server";
import { readWithOneRetry } from "@/lib/queries/schedule";
import type { DbClient, Views } from "@/lib/db/helpers";

/**
 * One row per player per TEAM (team pages) or per SEASON (leaderboards): a leaderboard on the
 * per-team view shows a transferred player twice. Named apart so the compiler keeps them apart.
 */
export type SkaterStat = Views<"v_skater_stats">;
export type GoalieStat = Views<"v_goalie_stats">;
export type SkaterTotals = Views<"v_skater_season_totals">;
export type GoalieTotals = Views<"v_goalie_season_totals">;

/**
 * Either shape, for the shared stats tables. The union stops compiling when a column exists on
 * only one view, the moment a table would start rendering blanks.
 */
export type SkaterRow = SkaterStat | SkaterTotals;
export type GoalieRow = GoalieStat | GoalieTotals;

/**
 * ⛔ An empty leaderboard is "nobody has been scored yet" — which is TRUE at the start of every
 * season, and so is exactly the message a failed read hides behind.
 */
export type SkaterLeadersRead = { rows: SkaterTotals[]; readFailed: boolean };
export type GoalieLeadersRead = { rows: GoalieTotals[]; readFailed: boolean };

export async function getSkaterLeaders(
  seasonId: string,
  opts: { limit?: number; client?: DbClient } = {},
): Promise<SkaterLeadersRead> {
  const { limit, client } = opts;
  const supabase = client ?? (await createClient());
  // ⛔ A factory, not a builder: an awaited PostgREST builder is spent, so the retry builds anew —
  // the conditional `.limit()` included.
  const { data, error } = await readWithOneRetry(() => {
    const q = supabase
      .from("v_skater_season_totals")
      .select("*")
      .eq("season_id", seasonId)
      .order("pts", { ascending: false })
      .order("g", { ascending: false });
    return limit ? q.limit(limit) : q;
  }, "skater leaders read");
  if (error) {
    console.error("skater leaders read failed:", error.message);
    return { rows: [], readFailed: true };
  }
  return { rows: data ?? [], readFailed: false };
}

/** Goalie leaderboard for a season, ordered by GAA (min 1 GP). */
export async function getGoalieLeaders(
  seasonId: string,
  opts: { limit?: number; client?: DbClient } = {},
): Promise<GoalieLeadersRead> {
  const { limit, client } = opts;
  const supabase = client ?? (await createClient());
  const { data, error } = await readWithOneRetry(() => {
    const q = supabase
      .from("v_goalie_season_totals")
      .select("*")
      .eq("season_id", seasonId)
      .order("gaa", { ascending: true });
    return limit ? q.limit(limit) : q;
  }, "goalie leaders read");
  if (error) {
    console.error("goalie leaders read failed:", error.message);
    return { rows: [], readFailed: true };
  }
  return { rows: data ?? [], readFailed: false };
}

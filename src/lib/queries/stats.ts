import { createClient } from "@/utils/supabase/server";
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

export async function getSkaterLeaders(
  seasonId: string,
  opts: { limit?: number; client?: DbClient } = {},
): Promise<SkaterTotals[]> {
  const { limit, client } = opts;
  const supabase = client ?? (await createClient());
  let q = supabase
    .from("v_skater_season_totals")
    .select("*")
    .eq("season_id", seasonId)
    .order("pts", { ascending: false })
    .order("g", { ascending: false });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) console.error("getSkaterLeaders failed:", error.message);
  return data ?? [];
}

/** Goalie leaderboard for a season, ordered by GAA (min 1 GP). */
export async function getGoalieLeaders(
  seasonId: string,
  opts: { limit?: number; client?: DbClient } = {},
): Promise<GoalieTotals[]> {
  const { limit, client } = opts;
  const supabase = client ?? (await createClient());
  let q = supabase
    .from("v_goalie_season_totals")
    .select("*")
    .eq("season_id", seasonId)
    .order("gaa", { ascending: true });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) console.error("getGoalieLeaders failed:", error.message);
  return data ?? [];
}

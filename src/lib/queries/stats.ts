import { createClient } from "@/utils/supabase/server";
import type { DbClient, Views } from "@/lib/db/helpers";

/**
 * Two shapes, and the difference is one row per player per TEAM versus one row
 * per player per SEASON.
 *
 * They were the same type until a player could be on more than one team in a
 * season. A leaderboard reading the per-team views now shows a transferred
 * player twice, each line holding half their season — so the leaderboards read
 * the totals and team pages keep reading the per-team views, which is what a
 * team page is asking for. Named separately so the compiler says which is which
 * at every call site rather than the two quietly standing in for each other.
 */
export type SkaterStat = Views<"v_skater_stats">;
export type GoalieStat = Views<"v_goalie_stats">;
export type SkaterTotals = Views<"v_skater_season_totals">;
export type GoalieTotals = Views<"v_goalie_season_totals">;

/**
 * What the shared stats tables render: either shape.
 *
 * `SkaterStatsTable` and `GoalieStatsTable` are used from the leaderboards
 * (totals) and from team pages (per-team), and the two views have identical
 * column lists today, so typing the tables on one of them compiles either way
 * and says nothing. The union says which two, and stops compiling the day a
 * column exists on only one of them — which is the moment a table would start
 * rendering blanks.
 */
export type SkaterRow = SkaterStat | SkaterTotals;
export type GoalieRow = GoalieStat | GoalieTotals;

/** Skater leaderboard for a season, ordered by points then goals. */
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

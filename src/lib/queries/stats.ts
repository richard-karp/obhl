import { createClient } from "@/utils/supabase/server";
import type { Views } from "@/lib/db/helpers";

export type SkaterStat = Views<"v_skater_stats">;
export type GoalieStat = Views<"v_goalie_stats">;

/** Skater leaderboard for a season, ordered by points then goals. */
export async function getSkaterLeaders(
  seasonId: string,
  limit?: number,
): Promise<SkaterStat[]> {
  const supabase = await createClient();
  let q = supabase
    .from("v_skater_stats")
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
  limit?: number,
): Promise<GoalieStat[]> {
  const supabase = await createClient();
  let q = supabase
    .from("v_goalie_stats")
    .select("*")
    .eq("season_id", seasonId)
    .order("gaa", { ascending: true });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) console.error("getGoalieLeaders failed:", error.message);
  return data ?? [];
}

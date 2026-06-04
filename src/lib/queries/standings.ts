import { createClient } from "@/utils/supabase/server";
import { rankStandings } from "@/lib/standings/tiebreakers";
import type { Views } from "@/lib/db/helpers";

export type StandingRow = Views<"v_standings_raw">;
export type RankedStanding = StandingRow & {
  teamId: string;
  rank: number;
};

/** Fetches raw standings + finalized games, returns them fully ranked. */
export async function getStandings(seasonId: string): Promise<RankedStanding[]> {
  const supabase = await createClient();
  const [{ data: raw }, { data: finals }] = await Promise.all([
    supabase.from("v_standings_raw").select("*").eq("season_id", seasonId),
    supabase
      .from("games")
      .select("home_team_id, away_team_id, home_goals, away_goals")
      .eq("season_id", seasonId)
      .eq("status", "final"),
  ]);

  const enriched = (raw ?? []).map((r) => ({
    ...r,
    teamId: r.team_id ?? "",
    points: r.points ?? 0,
    wins: r.wins ?? 0,
    gd: r.gd ?? 0,
    gf: r.gf ?? 0,
  }));

  const games = (finals ?? []).map((g) => ({
    homeTeamId: g.home_team_id,
    awayTeamId: g.away_team_id,
    homeGoals: g.home_goals,
    awayGoals: g.away_goals,
  }));

  return rankStandings(enriched, games);
}

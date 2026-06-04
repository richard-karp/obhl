import { createClient } from "@/utils/supabase/server";
import { getSchedule } from "./schedule";
import type { Tables, Views } from "@/lib/db/helpers";

export type TeamRow = Tables<"teams">;
export type TeamSummary = {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  logo_path: string | null;
};
export type RosterEntry = {
  player_id: string;
  first_name: string;
  last_name: string;
  jersey_number: number | null;
  position: "F" | "D" | "G";
  is_captain: boolean;
};

/** Teams enrolled in a season, alphabetical. */
export async function getEnrolledTeams(seasonId: string): Promise<TeamSummary[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("season_teams")
    .select("team:teams!season_teams_team_id_fkey(id, name, slug, color, logo_path)")
    .eq("season_id", seasonId);
  const teams = ((data ?? [])
    .map((r) => r.team)
    .filter(Boolean) as unknown) as TeamSummary[];
  return teams.sort((a, b) => a.name.localeCompare(b.name));
}

export type TeamDetail = {
  team: TeamRow;
  roster: RosterEntry[];
  skaters: Views<"v_skater_stats">[];
  goalies: Views<"v_goalie_stats">[];
  games: Awaited<ReturnType<typeof getSchedule>>;
};

/** Full team page payload: roster, stats, and the team's schedule. */
export async function getTeamBySlug(
  leagueId: string,
  seasonId: string,
  slug: string,
): Promise<TeamDetail | null> {
  const supabase = await createClient();
  const { data: team } = await supabase
    .from("teams")
    .select("*")
    .eq("league_id", leagueId)
    .eq("slug", slug)
    .maybeSingle();
  if (!team) return null;

  const [{ data: roster }, { data: skaters }, { data: goalies }, games] =
    await Promise.all([
      supabase
        .from("team_players")
        .select(
          "player_id, jersey_number, position, is_captain, players!team_players_player_id_fkey(first_name, last_name)",
        )
        .eq("season_id", seasonId)
        .eq("team_id", team.id)
        .order("jersey_number", { ascending: true }),
      supabase
        .from("v_skater_stats")
        .select("*")
        .eq("season_id", seasonId)
        .eq("team_id", team.id)
        .order("pts", { ascending: false }),
      supabase
        .from("v_goalie_stats")
        .select("*")
        .eq("season_id", seasonId)
        .eq("team_id", team.id),
      getSchedule(seasonId, team.id),
    ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const rosterEntries: RosterEntry[] = (roster ?? []).map((r: any) => ({
    player_id: r.player_id,
    first_name: r.players?.first_name ?? "",
    last_name: r.players?.last_name ?? "",
    jersey_number: r.jersey_number,
    position: r.position,
    is_captain: r.is_captain,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    team,
    roster: rosterEntries,
    skaters: skaters ?? [],
    goalies: goalies ?? [],
    games,
  };
}

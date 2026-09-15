import { createClient } from "@/utils/supabase/server";
import { getSchedule, readWithOneRetry } from "./schedule";
import type { DbClient, Tables, Views } from "@/lib/db/helpers";

export type TeamRow = Tables<"teams">;
export type TeamSummary = {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  logo_path: string | null;
  logo_text_color: string | null;
};
export type RosterEntry = {
  player_id: string;
  first_name: string;
  last_name: string;
  jersey_number: number | null;
  position: "F" | "D" | "G";
  is_captain: boolean;
  /**
   * The night this player turns out, 0=Sun..6=Sat, or null for no fixed one.
   * Rendered only when the season plays more than one — see `seasonNightsFor`.
   */
  night_of_week: number | null;
};

/**
 * ⚠️ A failed read looks like no teams enrolled, and the exports answer it with a 404 for a
 * team that exists: hence the retry (a GET) and the log.
 */
export async function getEnrolledTeams(
  seasonId: string,
  opts: { client?: DbClient } = {},
): Promise<TeamSummary[]> {
  const supabase = opts.client ?? (await createClient());
  // ⛔ A factory, not a builder: an awaited PostgREST builder is spent, so the retry builds anew.
  const { data, error } = await readWithOneRetry(
    () =>
      supabase
        .from("season_teams")
        .select(
          "team:teams!season_teams_team_id_fkey(id, name, slug, color, logo_path, logo_text_color)",
        )
        .eq("season_id", seasonId),
    "enrolled teams read",
  );
  if (error) console.error("enrolled teams query failed:", error.message);
  const teams = (data ?? [])
    .map((r) => r.team)
    .filter(Boolean) as unknown as TeamSummary[];
  return teams.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * ⛔ Null is never "no filter", or a caller who asked for one team gets the whole season
 * (`RUNBOOK.md` → Schedule edits and exports). A read that failed twice is null too: a 404.
 */
export async function getEnrolledTeamBySlug(
  seasonId: string,
  slug: string,
  opts: { client?: DbClient } = {},
): Promise<TeamSummary | null> {
  // Enrolled teams only, so a team of another season or league is null rather than a slug match.
  const teams = await getEnrolledTeams(seasonId, opts);
  // Slugs are lower-case in the database; `?team=Sharks` should still resolve,
  // the same allowance `resolveLeagueBySlug` makes for the league in the path.
  const wanted = slug.toLowerCase();
  return teams.find((t) => t.slug === wanted) ?? null;
}

export type TeamDetail = {
  team: TeamRow;
  roster: RosterEntry[];
  skaters: Views<"v_skater_stats">[];
  goalies: Views<"v_goalie_stats">[];
  games: Awaited<ReturnType<typeof getSchedule>>;
};

/**
 * ⚠️ `opts.client` keeps this unit-testable: `@/utils/supabase/server` imports `next/headers`,
 * which has no request context under vitest.
 */
export async function getTeamBySlug(
  leagueId: string,
  seasonId: string,
  slug: string,
  opts: { client?: DbClient } = {},
): Promise<TeamDetail | null> {
  const supabase = opts.client ?? (await createClient());
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
          "player_id, jersey_number, position, is_captain, night_of_week, players!team_players_player_id_fkey(first_name, last_name)",
        )
        .eq("season_id", seasonId)
        .eq("team_id", team.id)
        // Who is here now. A departed player's stats for this team stay visible below, which is
        // why their roster row is kept rather than deleted.
        .is("left_on", null)
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
      getSchedule(seasonId, { teamId: team.id }),
    ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const rosterEntries: RosterEntry[] = (roster ?? []).map((r: any) => ({
    player_id: r.player_id,
    first_name: r.players?.first_name ?? "",
    last_name: r.players?.last_name ?? "",
    jersey_number: r.jersey_number,
    position: r.position,
    is_captain: r.is_captain,
    night_of_week: r.night_of_week ?? null,
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

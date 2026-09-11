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
 * Teams enrolled in a season, alphabetical.
 *
 * ⚠️ A FAILED READ IS INDISTINGUISHABLE FROM "no teams enrolled" in the return
 * value, and both of this function's consumers turn that into something a
 * person sees: the schedule page draws an empty filter, and
 * `getEnrolledTeamBySlug` resolves nothing, which the export routes answer with
 * a 404 for a team that plainly exists. Hence both lines below.
 *
 * The retry is the one that closes the user-visible gap. A gateway 502 is a
 * valid HTTP response, so nothing beneath us retries it — see
 * `readWithOneRetry`, added after Kong blips turned CI red in three of six runs
 * on 2026-09-06. Safe here for the same reason it is safe there: this is a GET,
 * and running it twice is indistinguishable from running it once.
 *
 * The log is what makes the residual case findable. Without it a read that
 * fails BOTH times produces no output at all, and the 404 it causes looks
 * exactly like a team that was never enrolled.
 */
export async function getEnrolledTeams(
  seasonId: string,
  opts: { client?: DbClient } = {},
): Promise<TeamSummary[]> {
  const supabase = opts.client ?? (await createClient());
  // ⛔ A FACTORY, NOT A BUILDER. A PostgREST builder fires its request when
  // awaited, so the retry has to construct a fresh one rather than await a
  // spent object.
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
 * One enrolled team of a season, by the slug the schedule page's filter puts in
 * the URL — or null if the season does not hold it.
 *
 * Built on `getEnrolledTeams` rather than querying `teams` directly, so the set
 * of slugs an export accepts is exactly the set the filter can offer. A team
 * that exists but is enrolled in another season — or another league — resolves
 * to null here, and the export routes turn that into a 404.
 *
 * ⛔ Callers must NOT treat null as "no filter". A caller that fell back to the
 * whole season on an unresolved slug would hand back six teams' games to
 * someone who asked for one, which is the defect the team-scoped export exists
 * to fix.
 *
 * ⚠️ Null also covers a read that failed twice — `getEnrolledTeams` retries and
 * logs, but cannot report it through this return type. The export routes answer
 * 404 either way, deliberately: that is the same answer `publicLeagueOfSeason`
 * has always given for a failed read on the same request, and one read in a
 * pair reporting 500 while the other reports 404 would be worse than either.
 * The log line is what tells the two apart after the fact.
 */
export async function getEnrolledTeamBySlug(
  seasonId: string,
  slug: string,
  opts: { client?: DbClient } = {},
): Promise<TeamSummary | null> {
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
 * Full team page payload: roster, stats, and the team's schedule.
 *
 * ⚠️ `opts.client` EXISTS FOR THE SAME REASON IT DOES ON EVERY OTHER HELPER IN
 * THIS FILE, and this was the only one without it. A function that builds its
 * own client cannot be unit-tested at all: `@/utils/supabase/server` imports
 * `next/headers`, which has no request context under vitest. Defaulted, so no
 * caller changes.
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
        // The roster is who is here now. What a departed player earned for this
        // team stays visible just below, in v_skater_stats / v_goalie_stats —
        // which is exactly why their roster row is kept rather than deleted.
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

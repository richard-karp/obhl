import { createClient } from "@/utils/supabase/server";
import { rankStandings } from "@/lib/standings/tiebreakers";
import type { DbClient, Views } from "@/lib/db/helpers";

export type StandingRow = Views<"v_standings_raw">;
export type RankedStanding = StandingRow & {
  teamId: string;
  rank: number;
  /**
   * `teams.logo_text_color`, read alongside the view rather than added to it.
   * `v_standings_raw` (0007) already lifts `teams.color` out as `team_color`, so
   * the obvious move is to lift this one out beside it — but `team_color` has
   * five siblings in the stats views (0014, 0015, 0024, 0037), and re-issuing
   * one view invites re-issuing all six to keep them consistent. That is a lot
   * of shared read surface, and a lot of regenerated row types, for a
   * presentational string. One more small indexed read here buys the same thing
   * without touching a view.
   */
  team_logo_text_color: string | null;
};

/** Fetches raw standings + finalized games, returns them fully ranked. */
export async function getStandings(
  seasonId: string,
  opts: { client?: DbClient } = {},
): Promise<RankedStanding[]> {
  const supabase = opts.client ?? (await createClient());
  const [
    { data: raw, error: rawErr },
    { data: finals, error: finErr },
    { data: branding },
  ] = await Promise.all([
    supabase.from("v_standings_raw").select("*").eq("season_id", seasonId),
    supabase
      .from("games")
      .select("home_team_id, away_team_id, home_goals, away_goals")
      // Explicit rather than relying on `public read games` to exclude drafts:
      // an admin client bypasses that policy.
      .eq("is_draft", false)
      .eq("season_id", seasonId)
      .eq("status", "final"),
    // Through `season_teams` so this runs in parallel with the other two rather
    // than waiting on `raw` for a list of team ids.
    supabase
      .from("season_teams")
      .select("team_id, teams!season_teams_team_id_fkey(logo_text_color)")
      .eq("season_id", seasonId),
  ]);
  if (rawErr || finErr) {
    console.error("getStandings failed:", (rawErr ?? finErr)?.message);
  }

  // Missing rather than defaulted when the read comes back empty: `TeamLogo`
  // already treats anything that is not "dark" as the white letters it always
  // drew, so a failed branding read degrades to today's rendering rather than
  // to a blank chip.
  const inkOf = new Map<string, string | null>(
    (branding ?? []).map((r) => [r.team_id, r.teams?.logo_text_color ?? null]),
  );

  const enriched = (raw ?? []).map((r) => ({
    ...r,
    teamId: r.team_id ?? "",
    team_logo_text_color: inkOf.get(r.team_id ?? "") ?? null,
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

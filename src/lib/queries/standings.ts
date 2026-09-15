import { createClient } from "@/utils/supabase/server";
import { rankStandings } from "@/lib/standings/tiebreakers";
import { readWithOneRetry } from "@/lib/queries/schedule";
import type { DbClient, Views } from "@/lib/db/helpers";

export type StandingRow = Views<"v_standings_raw">;
export type RankedStanding = StandingRow & {
  teamId: string;
  rank: number;
  /**
   * ⚠️ Read beside `v_standings_raw`, not added to it: one row per team makes a separate read
   * cheap here, unlike the per-player leaderboards, whose views `0044` widened instead.
   */
  team_logo_text_color: string | null;
  /** Travels with the ink because the crest overrides it: `TeamLogo` then draws no letters. */
  team_logo_path: string | null;
};

/**
 * ⛔ `rows` empty and `readFailed` false is "nobody has played yet"; `readFailed` true is "we
 * could not look". The table renders the first as a league with no results, which is a statement
 * about the season rather than about the read.
 */
export type StandingsRead = { rows: RankedStanding[]; readFailed: boolean };

export async function getStandings(
  seasonId: string,
  opts: { client?: DbClient } = {},
): Promise<StandingsRead> {
  const supabase = opts.client ?? (await createClient());
  const [
    { data: raw, error: rawErr },
    { data: finals, error: finErr },
    { data: branding },
  ] = await Promise.all([
    // ⚠️ Only the two reads the failure check below depends on are retried. The branding read is
    // left bare on purpose: its failure degrades to a plain chip, a real fallback rather than a
    // wrong table.
    readWithOneRetry(
      () =>
        supabase.from("v_standings_raw").select("*").eq("season_id", seasonId),
      "standings read",
    ),
    readWithOneRetry(
      () =>
        supabase
          .from("games")
          .select("home_team_id, away_team_id, home_goals, away_goals")
          // Explicit rather than relying on `public read games` to exclude drafts:
          // an admin client bypasses that policy.
          .eq("is_draft", false)
          .eq("season_id", seasonId)
          .eq("status", "final"),
      "standings finals read",
    ),
    // Through `season_teams`, so it runs in parallel rather than waiting on `raw` for team ids.
    supabase
      .from("season_teams")
      .select(
        "team_id, teams!season_teams_team_id_fkey(logo_text_color, logo_path)",
      )
      .eq("season_id", seasonId),
  ]);
  // ⚠️ The branding read is deliberately NOT here: its failure degrades to a plain chip (see
  // below), which is a real fallback rather than a wrong standings table.
  if (rawErr || finErr) {
    console.error("standings read failed:", (rawErr ?? finErr)?.message);
    return { rows: [], readFailed: true };
  }

  // Missing, not defaulted: `TeamLogo` treats anything but "dark" as white letters, so a failed
  // branding read degrades to the plain chip rather than a blank one.
  const brandOf = new Map<
    string,
    { textColor: string | null; logoPath: string | null }
  >(
    (branding ?? []).map((r) => [
      r.team_id,
      {
        textColor: r.teams?.logo_text_color ?? null,
        logoPath: r.teams?.logo_path ?? null,
      },
    ]),
  );

  const enriched = (raw ?? []).map((r) => ({
    ...r,
    teamId: r.team_id ?? "",
    team_logo_text_color: brandOf.get(r.team_id ?? "")?.textColor ?? null,
    team_logo_path: brandOf.get(r.team_id ?? "")?.logoPath ?? null,
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

  return { rows: rankStandings(enriched, games), readFailed: false };
}

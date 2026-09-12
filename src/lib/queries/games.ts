import { createClient } from "@/utils/supabase/server";
import { goalieLine, resolveGoalieOfRecord } from "@/lib/goalie/of-record";

export type BoxLine = {
  team_id: string;
  number: number | null;
  name: string;
  goals: number;
  assists: number;
  pim: number;
};

/**
 * A team's goaltending for one game: who was in net and how they did.
 *
 * ⚠️ THREE STATES, AND THE LAST TWO ARE NOT THE SAME. `sub` is a substitute
 * goalie — recorded, deliberately carrying no individual record (`0015`).
 * `none` is nobody having entered anything, which four of the six team-sides in
 * production were on 2026-09-12. Rendering them alike would report a
 * correctly-entered sheet as an omission.
 */
export type BoxGoalie =
  | {
      kind: "player";
      number: number | null;
      name: string;
      ga: number;
      shutout: boolean;
      outcome: "W" | "L" | "T";
    }
  | { kind: "sub" }
  | { kind: "none" };

/**
 * Public box score for a game. The dressed roster (with per-player goal/assist/
 * PIM counters) is only readable for FINAL games (RLS), so for non-final games
 * `lines` comes back empty.
 */
export async function getGameBoxScore(gameId: string) {
  const supabase = await createClient();
  const { data: game } = await supabase
    .from("games")
    .select(
      // `season.league_id` is what lets the page reject a game belonging to a
      // different league than the one in its URL.
      //
      // ⛔ THE GOALIES ARE EMBEDDED, NOT LOOKED UP IN THE ROSTER LINES.
      // `v_goalie_stats` credits `{home,away}_goalie_id` whether or not that
      // player has a `game_rosters` row — its first branch joins nothing — so a
      // goalie of record who is not dressed is representable, and reading the
      // name off the lines would print their GA beside a blank. It does not
      // happen today, because `setGoalie` inserts the row; it costs no extra
      // round trip to be right when that stops being true.
      `id, scheduled_at, status, week, round, home_goals, away_goals, result_type, season_id,
       home_goalie_id, away_goalie_id, home_goalie_is_sub, away_goalie_is_sub,
       home_empty_net_against, away_empty_net_against,
       season:seasons!inner(league_id),
       home_goalie:players!games_home_goalie_id_fkey(first_name, last_name),
       away_goalie:players!games_away_goalie_id_fkey(first_name, last_name),
       home_team:teams!games_home_team_id_fkey(id, name, slug, color, logo_path, logo_text_color),
       away_team:teams!games_away_team_id_fkey(id, name, slug, color, logo_path, logo_text_color)`,
    )
    .eq("id", gameId)
    .maybeSingle();

  if (!game) return null;

  const [{ data: rosters }, { data: tp }] = await Promise.all([
    supabase
      .from("game_rosters")
      .select(
        "team_id, player_id, goals, assists, pim, is_substitute, player:players!game_rosters_player_id_fkey(first_name, last_name)",
      )
      .eq("game_id", gameId),
    // NOT filtered on `left_on`, and keyed by team as well as player.
    //
    // A box score shows the number a player wore in THAT game, which is the
    // number on their roster row for the team they played it for — a departed
    // row, once they move on. Filtering to active rows would blank the numbers
    // on every past game a transferred player appears in; keying by player
    // alone would print their new team's number on their old team's line.
    // ⚠️ `position` rides along for the goalie fallback below, and inherits the
    // same reasoning: a departed goalie still played the games they played.
    supabase
      .from("team_players")
      .select("player_id, team_id, jersey_number, position")
      .eq("season_id", game.season_id),
  ]);

  const jersey = new Map<string, number | null>();
  const isGoalie = new Set<string>();
  for (const r of tp ?? []) {
    jersey.set(`${r.player_id}|${r.team_id}`, r.jersey_number);
    if (r.position === "G") isGoalie.add(`${r.player_id}|${r.team_id}`);
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const lines: BoxLine[] = (rosters ?? []).map((r: any) => ({
    team_id: r.team_id,
    number: jersey.get(`${r.player_id}|${r.team_id}`) ?? null,
    name: r.is_substitute
      ? "Substitutes"
      : r.player
        ? `${r.player.first_name} ${r.player.last_name}`
        : "",
    goals: r.goals ?? 0,
    assists: r.assists ?? 0,
    pim: r.pim ?? 0,
  }));

  /**
   * A side's goaltending, resolved the way `v_goalie_stats` resolves it.
   *
   * ⚠️ NOT RESTRICTED TO REGULAR-SEASON GAMES, unlike the view (`0044`:
   * `game_type = 'regular' and not is_draft`). A playoff game therefore shows a
   * goaltending line that contributes to no season total. That is correct — the
   * line describes the game in front of you — and it reads as an inconsistency
   * to anyone who diffs the two, so: it is deliberate.
   */
  const boxGoalie = (which: "home" | "away"): BoxGoalie => {
    const g = game as any;
    const teamId: string | undefined = g[`${which}_team`]?.id;
    const goalsFor: number = g[`${which}_goals`] ?? 0;
    const goalsAgainst: number =
      g[which === "home" ? "away_goals" : "home_goals"] ?? 0;

    const input = {
      goalieId: (g[`${which}_goalie_id`] as string | null) ?? null,
      goalieIsSub: !!g[`${which}_goalie_is_sub`],
      // The fallback pool: dressed for this team AND `position = 'G'` on their
      // roster row — the same join `v_goalie_stats` makes.
      dressedGoalieIds: (rosters ?? [])
        .filter((r: any) => r.team_id === teamId && r.player_id)
        .map((r: any) => r.player_id as string)
        .filter((id) => isGoalie.has(`${id}|${teamId}`)),
    };

    const line = goalieLine({
      ...input,
      goalsAgainst,
      emptyNetAgainst: g[`${which}_empty_net_against`] ?? 0,
      // The same comparison `v_team_game_results` makes, per side.
      outcome:
        goalsFor > goalsAgainst ? "W" : goalsFor < goalsAgainst ? "L" : "T",
    });
    if (!line) return resolveGoalieOfRecord(input) as { kind: "sub" | "none" };

    // ⚠️ TWO NAME SOURCES, AND EACH COVERS WHAT THE OTHER CANNOT. The embedded
    // `players` row exists only for an EXPLICIT pick — it is joined off
    // `games.{home,away}_goalie_id` — while the dressed fallback has no such
    // row and must be read off its own roster line, where it is guaranteed to
    // appear because being dressed is what selected it.
    const embedded = g[`${which}_goalie`];
    const fromLines = (rosters ?? []).find(
      (r: any) => r.player_id === line.playerId && r.team_id === teamId,
    ) as any;
    const person =
      line.playerId === input.goalieId ? embedded : fromLines?.player;

    return {
      kind: "player",
      number: jersey.get(`${line.playerId}|${teamId}`) ?? null,
      name: person ? `${person.first_name} ${person.last_name}` : "",
      ga: line.ga,
      shutout: line.shutout,
      outcome: line.outcome,
    };
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    game,
    lines,
    goalies: { home: boxGoalie("home"), away: boxGoalie("away") },
  };
}

export type LatestRecapGame = {
  id: string;
  scheduled_at: string;
  home_goals: number;
  away_goals: number;
  home_team_name: string;
  away_team_name: string;
  ai_recap: string | null;
};

export async function getLatestGameWithRecapData(
  seasonId: string,
): Promise<LatestRecapGame | null> {
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from("games")
    .select(
      "id, scheduled_at, home_goals, away_goals, ai_recap, " +
        "home_team:teams!games_home_team_id_fkey(name), " +
        "away_team:teams!games_away_team_id_fkey(name)",
    )
    .eq("season_id", seasonId)
    .eq("status", "final")
    .order("scheduled_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;
  return {
    id: d.id,
    scheduled_at: d.scheduled_at,
    home_goals: d.home_goals ?? 0,
    away_goals: d.away_goals ?? 0,
    home_team_name: d.home_team?.name ?? "",
    away_team_name: d.away_team?.name ?? "",
    ai_recap: d.ai_recap ?? null,
  };
}

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
 * ⚠️ `sub` (a recorded substitute with no individual record, `0015`) is not `none` (nothing
 * entered): rendering them alike reports a correctly entered sheet as an omission.
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

/** The dressed roster is readable only for FINAL games (RLS), so `lines` is empty before then. */
export async function getGameBoxScore(gameId: string) {
  const supabase = await createClient();
  const { data: game } = await supabase
    .from("games")
    .select(
      // ⛔ Goalies are embedded, not read off the lines: `v_goalie_stats` credits a goalie of
      // record with no `game_rosters` row. `season.league_id` lets the page refuse another league.
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
    // Not filtered on `left_on`, and keyed by team too: a box score shows the number worn in
    // THAT game, on the row for the team played for. `position` feeds the goalie fallback.
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
   * ⚠️ Deliberately not restricted to regular-season games, unlike `v_goalie_stats` (`0044`):
   * a playoff line describes the game in front of you, though it counts toward no total.
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

    const record = resolveGoalieOfRecord(input);
    if (record.kind !== "player") return record;

    const line = goalieLine({
      ...input,
      goalsAgainst,
      emptyNetAgainst: g[`${which}_empty_net_against`] ?? 0,
      // The same comparison `v_team_game_results` makes, per side.
      outcome:
        goalsFor > goalsAgainst ? "W" : goalsFor < goalsAgainst ? "L" : "T",
    })!;

    // ⚠️ Two name sources: the embedded `players` row exists only for an explicit pick, and the
    // dressed fallback's name comes from its own roster line.
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

import { createClient } from "@/utils/supabase/server";

export type BoxLine = {
  team_id: string;
  number: number | null;
  name: string;
  goals: number;
  assists: number;
  pim: number;
};

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
      `id, scheduled_at, status, week, round, home_goals, away_goals, result_type, season_id,
       home_team:teams!games_home_team_id_fkey(id, name, slug, color),
       away_team:teams!games_away_team_id_fkey(id, name, slug, color)`,
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
    supabase
      .from("team_players")
      .select("player_id, jersey_number")
      .eq("season_id", game.season_id),
  ]);

  const jersey = new Map<string, number | null>();
  for (const r of tp ?? []) jersey.set(r.player_id, r.jersey_number);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const lines: BoxLine[] = (rosters ?? []).map((r: any) => ({
    team_id: r.team_id,
    number: jersey.get(r.player_id) ?? null,
    name: r.is_substitute
      ? "Substitutes"
      : r.player
        ? `${r.player.first_name} ${r.player.last_name}`
        : "",
    goals: r.goals ?? 0,
    assists: r.assists ?? 0,
    pim: r.pim ?? 0,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { game, lines };
}

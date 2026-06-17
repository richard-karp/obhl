import { createClient } from "@/utils/supabase/server";
import type { ThreeStarEntry } from "@/lib/utils/three-stars";

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

export type LatestRecapGame = {
  id: string;
  scheduled_at: string;
  home_goals: number;
  away_goals: number;
  home_team_name: string;
  away_team_name: string;
  three_stars: ThreeStarEntry[] | null;
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
      "id, scheduled_at, home_goals, away_goals, three_stars, ai_recap, " +
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
    three_stars: (d.three_stars as ThreeStarEntry[]) ?? null,
    ai_recap: d.ai_recap ?? null,
  };
}

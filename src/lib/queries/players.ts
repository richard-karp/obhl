import { createClient } from "@/utils/supabase/server";
import type { SkaterStat, GoalieStat } from "@/lib/queries/stats";

export type PlayerBio = {
  player_id: string;
  first_name: string;
  last_name: string;
  jersey_number: number | null;
  position: "F" | "D" | "G";
  is_captain: boolean;
  is_rookie: boolean;
  injury_notes: string | null;
  is_suspended: boolean;
  team_id: string;
  team_name: string;
  team_slug: string;
  team_color: string | null;
  team_logo_path: string | null;
};

export type PlayerGameLogRow = {
  game_id: string;
  date: string;
  opponent_name: string;
  opponent_slug: string;
  opponent_color: string | null;
  team_goals: number;
  opp_goals: number;
  goals: number;
  assists: number;
  pts: number;
  pim: number;
};

export type PlayerVsOpponent = {
  opponent_id: string;
  opponent_name: string;
  opponent_slug: string;
  opponent_color: string | null;
  gp: number;
  g: number;
  a: number;
  pts: number;
  pim: number;
};

export async function getPlayerBio(
  playerId: string,
  seasonId: string,
): Promise<PlayerBio | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("team_players")
    .select(
      "jersey_number, position, is_captain, is_rookie, injury_notes, is_suspended, player_id, " +
      "players!team_players_player_id_fkey(first_name, last_name), " +
      "teams!team_players_team_id_fkey(id, name, slug, color, logo_path)",
    )
    .eq("player_id", playerId)
    .eq("season_id", seasonId)
    .maybeSingle();

  if (error) console.error("getPlayerBio failed:", error.message);

  if (data) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = data as any;
    return {
      player_id: playerId,
      first_name: d.players?.first_name ?? "",
      last_name: d.players?.last_name ?? "",
      jersey_number: d.jersey_number ?? null,
      position: d.position,
      is_captain: d.is_captain,
      is_rookie: d.is_rookie,
      injury_notes: d.injury_notes ?? null,
      is_suspended: d.is_suspended,
      team_id: d.teams?.id ?? "",
      team_name: d.teams?.name ?? "",
      team_slug: d.teams?.slug ?? "",
      team_color: d.teams?.color ?? null,
      team_logo_path: d.teams?.logo_path ?? null,
    };
  }

  // Fallback: player appeared in game_rosters (e.g. as a substitute) but has
  // no team_players row for this season. Pull name from players table and
  // team/position from v_skater_stats; status flags default to safe values.
  const [{ data: player }, { data: stat }] = await Promise.all([
    supabase
      .from("players")
      .select("first_name, last_name")
      .eq("id", playerId)
      .maybeSingle(),
    supabase
      .from("v_skater_stats")
      .select("team_id, team_name, team_slug, team_color, position, jersey_number")
      .eq("player_id", playerId)
      .eq("season_id", seasonId)
      .maybeSingle(),
  ]);

  if (!player) return null;

  return {
    player_id: playerId,
    first_name: player.first_name,
    last_name: player.last_name,
    jersey_number: stat?.jersey_number ?? null,
    position: (stat?.position as PlayerBio["position"]) ?? "F",
    is_captain: false,
    is_rookie: false,
    injury_notes: null,
    is_suspended: false,
    team_id: stat?.team_id ?? "",
    team_name: stat?.team_name ?? "",
    team_slug: stat?.team_slug ?? "",
    team_color: stat?.team_color ?? null,
    team_logo_path: null,
  };
}

export async function getPlayerSkaterStats(
  playerId: string,
  seasonId: string,
): Promise<SkaterStat | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("v_skater_stats")
    .select("*")
    .eq("player_id", playerId)
    .eq("season_id", seasonId)
    .maybeSingle();
  return data ?? null;
}

export async function getPlayerGoalieStats(
  playerId: string,
  seasonId: string,
): Promise<GoalieStat | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("v_goalie_stats")
    .select("*")
    .eq("player_id", playerId)
    .eq("season_id", seasonId)
    .maybeSingle();
  return data ?? null;
}

export async function getPlayerGameLog(
  playerId: string,
  seasonId: string,
  limit = 10,
): Promise<PlayerGameLogRow[]> {
  const supabase = await createClient();

  const { data: rosterEntries } = await supabase
    .from("game_rosters")
    .select("game_id, team_id, goals, assists, pim")
    .eq("player_id", playerId)
    .eq("is_substitute", false);

  if (!rosterEntries || rosterEntries.length === 0) return [];

  const gameIds = rosterEntries.map((r) => r.game_id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: gamesRaw } = await (supabase as any)
    .from("games")
    .select(
      "id, scheduled_at, home_goals, away_goals, home_team_id, away_team_id, " +
      "home_team:teams!games_home_team_id_fkey(id, name, slug, color), " +
      "away_team:teams!games_away_team_id_fkey(id, name, slug, color)",
    )
    .in("id", gameIds)
    .eq("season_id", seasonId)
    .eq("status", "final")
    .order("scheduled_at", { ascending: false })
    .limit(limit);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const games: any[] = gamesRaw ?? [];
  if (games.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gameMap = new Map<string, any>(games.map((g) => [g.id, g]));

  return rosterEntries
    .filter((r) => gameMap.has(r.game_id))
    .map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = gameMap.get(r.game_id) as any;
      const isHome = r.team_id === g.home_team_id;
      const opp = isHome ? g.away_team : g.home_team;
      return {
        game_id: r.game_id,
        date: g.scheduled_at,
        opponent_name: opp?.name ?? "Unknown",
        opponent_slug: opp?.slug ?? "",
        opponent_color: opp?.color ?? null,
        team_goals: isHome ? g.home_goals : g.away_goals,
        opp_goals: isHome ? g.away_goals : g.home_goals,
        goals: r.goals,
        assists: r.assists,
        pts: r.goals + r.assists,
        pim: r.pim,
      };
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);
}

export async function getPlayerStatsByOpponent(
  playerId: string,
  seasonId: string,
): Promise<PlayerVsOpponent[]> {
  const supabase = await createClient();

  const { data: rosterEntries } = await supabase
    .from("game_rosters")
    .select("game_id, team_id, goals, assists, pim")
    .eq("player_id", playerId)
    .eq("is_substitute", false);

  if (!rosterEntries || rosterEntries.length === 0) return [];

  const gameIds = rosterEntries.map((r) => r.game_id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: gamesRaw } = await (supabase as any)
    .from("games")
    .select(
      "id, home_team_id, away_team_id, " +
      "home_team:teams!games_home_team_id_fkey(id, name, slug, color), " +
      "away_team:teams!games_away_team_id_fkey(id, name, slug, color)",
    )
    .in("id", gameIds)
    .eq("season_id", seasonId)
    .eq("status", "final");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oppGames: any[] = gamesRaw ?? [];
  if (oppGames.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gameMap = new Map<string, any>(oppGames.map((g) => [g.id, g]));

  // Aggregate per opponent
  const byOpponent = new Map<string, PlayerVsOpponent>();

  for (const r of rosterEntries) {
    const g = gameMap.get(r.game_id);
    if (!g) continue;
    const isHome = r.team_id === g.home_team_id;
    const opp = isHome ? g.away_team : g.home_team;
    if (!opp) continue;

    const existing = byOpponent.get(opp.id);
    if (existing) {
      existing.gp += 1;
      existing.g += r.goals;
      existing.a += r.assists;
      existing.pts += r.goals + r.assists;
      existing.pim += r.pim;
    } else {
      byOpponent.set(opp.id, {
        opponent_id: opp.id,
        opponent_name: opp.name,
        opponent_slug: opp.slug,
        opponent_color: opp.color ?? null,
        gp: 1,
        g: r.goals,
        a: r.assists,
        pts: r.goals + r.assists,
        pim: r.pim,
      });
    }
  }

  return [...byOpponent.values()].sort((a, b) => b.pts - a.pts || b.g - a.g);
}

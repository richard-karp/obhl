import { createClient } from "@/utils/supabase/server";
import { leagueDateKey } from "@/lib/format";

// Shared select for a game with both teams embedded (disambiguated by FK).
const GAME_SELECT = `
  id, scheduled_at, status, week, round, home_goals, away_goals, result_type, is_draft, label,
  home_team:teams!games_home_team_id_fkey(id, name, slug, color),
  away_team:teams!games_away_team_id_fkey(id, name, slug, color)
`;

export type GameWithTeams = {
  id: string;
  scheduled_at: string | null;
  status: "scheduled" | "in_progress" | "final" | "postponed" | "cancelled";
  week: number | null;
  round: number | null;
  home_goals: number;
  away_goals: number;
  result_type: "regulation" | "overtime" | "shootout";
  is_draft: boolean;
  label: string | null;
  home_team: { id: string; name: string; slug: string; color: string | null } | null;
  away_team: { id: string; name: string; slug: string; color: string | null } | null;
};

/** All published games for a season, optionally filtered to one team. */
export async function getSchedule(
  seasonId: string,
  teamId?: string,
): Promise<GameWithTeams[]> {
  const supabase = await createClient();
  let q = supabase
    .from("games")
    .select(GAME_SELECT)
    .eq("season_id", seasonId)
    .eq("is_draft", false)
    .order("scheduled_at", { ascending: true });
  if (teamId) {
    q = q.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
  }
  const { data, error } = await q;
  if (error) console.error("schedule query failed:", error.message);
  return (data ?? []) as unknown as GameWithTeams[];
}

/** Upcoming (scheduled, future) games. */
export async function getUpcoming(
  seasonId: string,
  limit = 5,
  teamId?: string,
): Promise<GameWithTeams[]> {
  const supabase = await createClient();
  let q = supabase
    .from("games")
    .select(GAME_SELECT)
    .eq("season_id", seasonId)
    .eq("is_draft", false)
    .eq("status", "scheduled")
    .gte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(limit);
  if (teamId) q = q.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
  const { data, error } = await q;
  if (error) console.error("schedule query failed:", error.message);
  return (data ?? []) as unknown as GameWithTeams[];
}

export type SeasonNightGame = {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  scheduledAt: string;
  label: string | null;
};

export type SeasonNight = {
  /** League-local calendar date, "YYYY-MM-DD". */
  date: string;
  /**
   * The repair may not touch this night: it's in the past, or one of its games
   * has moved off `scheduled` (played, in progress, postponed, cancelled).
   * Whole-night granularity, because re-pairing part of a night would break
   * one-game-per-team.
   */
  locked: boolean;
  /** The night's games in ice-time order. */
  games: SeasonNightGame[];
};

/**
 * A season's published games grouped into nights, in the shape the one-off
 * planner reasons about. Undated games are dropped — they have no night to
 * belong to.
 */
export async function getSeasonNights(seasonId: string): Promise<SeasonNight[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("games")
    .select("id, scheduled_at, status, label, home_team_id, away_team_id")
    .eq("season_id", seasonId)
    .eq("is_draft", false)
    .order("scheduled_at", { ascending: true });
  if (error) {
    console.error("season nights query failed:", error.message);
    return [];
  }

  const today = leagueDateKey(new Date().toISOString());
  const byDate = new Map<string, { games: SeasonNightGame[]; locked: boolean }>();
  for (const g of data ?? []) {
    if (!g.scheduled_at) continue;
    const date = leagueDateKey(g.scheduled_at);
    const night =
      byDate.get(date) ?? byDate.set(date, { games: [], locked: date < today }).get(date)!;
    if (g.status !== "scheduled") night.locked = true;
    night.games.push({
      id: g.id,
      homeTeamId: g.home_team_id,
      awayTeamId: g.away_team_id,
      scheduledAt: g.scheduled_at,
      label: g.label,
    });
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, n]) => ({
      date,
      locked: n.locked,
      games: n.games.sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1)),
    }));
}

/** Most recent final games. */
export async function getRecentResults(
  seasonId: string,
  limit = 5,
  teamId?: string,
): Promise<GameWithTeams[]> {
  const supabase = await createClient();
  let q = supabase
    .from("games")
    .select(GAME_SELECT)
    .eq("season_id", seasonId)
    .eq("status", "final")
    .order("scheduled_at", { ascending: false })
    .limit(limit);
  if (teamId) q = q.or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
  const { data, error } = await q;
  if (error) console.error("schedule query failed:", error.message);
  return (data ?? []) as unknown as GameWithTeams[];
}

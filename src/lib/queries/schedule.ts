import { createClient } from "@/utils/supabase/server";

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
  const { data } = await q;
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
  const { data } = await q;
  return (data ?? []) as unknown as GameWithTeams[];
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
  const { data } = await q;
  return (data ?? []) as unknown as GameWithTeams[];
}

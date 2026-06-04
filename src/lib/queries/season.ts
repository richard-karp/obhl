import { createClient } from "@/utils/supabase/server";
import { resolveCurrentLeague } from "@/lib/league/current";
import type { Tables } from "@/lib/db/helpers";

export type League = Tables<"leagues">;
export type Season = Tables<"seasons">;

/**
 * Resolves the site context: the current (cookie-selected, or first) public
 * league and its active season. The header switcher chooses the league; see
 * lib/league/current.ts. Returns null if no public league exists.
 */
export async function getActiveContext(): Promise<
  { league: League; season: Season | null } | null
> {
  const supabase = await createClient();
  const league = await resolveCurrentLeague(supabase);
  if (!league) return null;

  const { data: season } = await supabase
    .from("seasons")
    .select("*")
    .eq("league_id", league.id)
    .eq("is_active", true)
    .maybeSingle();

  return { league, season: season ?? null };
}

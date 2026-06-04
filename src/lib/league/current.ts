import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import type { Tables } from "@/lib/db/helpers";

/**
 * Multi-league resolution. The site serves one or more public leagues; the
 * "current" league is chosen with a cookie set by the header switcher and falls
 * back to the first public league. A single resolver keeps the public site and
 * the manage tools pointed at the same league. Works with either the RLS user
 * client or the admin client (both are SupabaseClient<Database>).
 */
export const LEAGUE_COOKIE = "obhl_league";

type Client = SupabaseClient<Database>;
export type LeagueOption = { id: string; name: string; slug: string };

export async function resolveCurrentLeague(
  client: Client,
): Promise<Tables<"leagues"> | null> {
  const store = await cookies();
  const slug = store.get(LEAGUE_COOKIE)?.value;

  if (slug) {
    const { data } = await client
      .from("leagues")
      .select("*")
      .eq("slug", slug)
      .eq("is_public", true)
      .maybeSingle();
    if (data) return data;
  }

  const { data } = await client
    .from("leagues")
    .select("*")
    .eq("is_public", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** All public leagues, for the switcher. */
export async function getPublicLeagues(client: Client): Promise<LeagueOption[]> {
  const { data } = await client
    .from("leagues")
    .select("id, name, slug")
    .eq("is_public", true)
    .order("created_at", { ascending: true });
  return data ?? [];
}

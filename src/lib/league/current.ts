import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import type { Database } from "@/lib/db/types";
import type { Tables } from "@/lib/db/helpers";

type Client = SupabaseClient<Database>;
export type LeagueOption = { id: string; name: string; slug: string };

/**
 * Not filtered on `is_public`: RLS resolves a staged league for its members (`0042`). Keyed on
 * the slug alone, so the client is built inside; one passed in would miss the cache every call.
 */
export const resolveLeagueBySlug = cache(async function resolveLeagueBySlug(
  slug: string,
): Promise<Tables<"leagues"> | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("leagues")
    .select("*")
    // Slugs are lower-case in the database; `/OBHL` should still resolve.
    .eq("slug", slug.toLowerCase())
    .maybeSingle();
  return data ?? null;
});

export async function getPublicLeagues(
  client: Client,
): Promise<LeagueOption[]> {
  const { data, error } = await client
    .from("leagues")
    .select("id, name, slug")
    .eq("is_public", true)
    .order("created_at", { ascending: true });
  // ⚠️ An empty list silently empties the landing page, so a failed read is logged.
  if (error) console.error("getPublicLeagues failed:", error.message);
  return data ?? [];
}

/**
 * For the export feeds: through RLS, unlike `lib/league/of-entity`, which reads on the admin
 * client for guards. A league the viewer cannot see names itself to nobody here.
 */
export async function publicLeagueOfSeason(
  seasonId: string,
): Promise<LeagueOption | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("seasons")
    .select("leagues!inner(id, name, slug)")
    .eq("id", seasonId)
    .maybeSingle();
  return data?.leagues ?? null;
}

export async function publicLeagueOfTeam(
  teamId: string,
): Promise<LeagueOption | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("teams")
    .select("leagues!inner(id, name, slug)")
    .eq("id", teamId)
    .maybeSingle();
  return data?.leagues ?? null;
}

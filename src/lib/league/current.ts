import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import type { Database } from "@/lib/db/types";
import type { Tables } from "@/lib/db/helpers";

type Client = SupabaseClient<Database>;
export type LeagueOption = { id: string; name: string; slug: string };

/**
 * Multi-league resolution. The league lives in the URL — `/harbor/standings`,
 * `/harbor/seasons` — so a link to one league is a link to that league
 * for whoever opens it.
 *
 * Memoized with `cache` because App Router layouts cannot hand data to the
 * pages beneath them: `[league]/layout.tsx`, `(public)/layout.tsx` and the page
 * each resolve independently and would otherwise fire the same query three or
 * four times per render. The key is the slug alone, so the client is built
 * inside rather than passed in — a fresh `createClient()` per caller would make
 * every call a cache miss.
 *
 * Resolution is deliberately not filtered on `is_public`; `(public)/layout.tsx`
 * applies that. A league can therefore be staged — manageable before it is
 * visible. RLS narrows this for us: "public read leagues" exposes only
 * `is_public` rows, "manager write leagues" is `for all` for a manager of it, and
 * 0039's "member read leagues" adds any member — so a staged league resolves for
 * its own people and 404s for everyone else. What those people then SEE is
 * another question: the child tables are still gated on `is_public`, so a
 * non-manager member gets the league and an empty page. See 0039.
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

/** Public leagues only — the root landing page. */
export async function getPublicLeagues(
  client: Client,
): Promise<LeagueOption[]> {
  const { data } = await client
    .from("leagues")
    .select("id, name, slug")
    .eq("is_public", true)
    .order("created_at", { ascending: true });
  return data ?? [];
}

/**
 * The league a season / team belongs to, for the public export routes.
 *
 * Distinct from `lib/league/of-entity`, which answers the same question on the
 * ADMIN client and returns only an id, because it is deciding whether a caller
 * may act. These are for feeds: they read through RLS, so a league that isn't
 * publicly visible names itself to nobody, and they return what a calendar or a
 * filename needs.
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

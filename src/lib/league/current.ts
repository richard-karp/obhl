import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import type { Database } from "@/lib/db/types";
import type { Tables } from "@/lib/db/helpers";

type Client = SupabaseClient<Database>;
export type LeagueOption = { id: string; name: string; slug: string };

/**
 * Multi-league resolution. The league lives in the URL — `/harbor/standings`,
 * `/harbor/manage/seasons` — so a link to one league is a link to that league
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
 * `is_public` rows, while a manager's "manager write leagues" policy is `for
 * all`, so a staged league resolves for its manager and 404s for everyone else.
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
export async function getPublicLeagues(client: Client): Promise<LeagueOption[]> {
  const { data } = await client
    .from("leagues")
    .select("id, name, slug")
    .eq("is_public", true)
    .order("created_at", { ascending: true });
  return data ?? [];
}

/**
 * Every league the caller can see, for the manage switcher. A staged league is
 * absent from `getPublicLeagues`, so a switcher built from that list would show
 * its own manager a selected value that isn't among its options — and the
 * browser would render some other league's name as the current one.
 *
 * RLS still decides what "can see" means: managers get every league, everyone
 * else only the public ones.
 */
export async function getAllLeagues(client: Client): Promise<LeagueOption[]> {
  const { data } = await client
    .from("leagues")
    .select("id, name, slug")
    .order("created_at", { ascending: true });
  return data ?? [];
}

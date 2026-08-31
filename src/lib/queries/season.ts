import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { resolveCurrentLeague, resolveLeagueBySlug } from "@/lib/league/current";
import type { Tables } from "@/lib/db/helpers";

export type League = Tables<"leagues">;
export type Season = Tables<"seasons">;
export type ActiveContext = { league: League; season: Season | null };

/** The league's active season. Memoized: several segments ask per render. */
const getActiveSeason = cache(async function getActiveSeason(
  leagueId: string,
): Promise<Season | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("seasons")
    .select("*")
    .eq("league_id", leagueId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) console.error("getActiveContext (season) failed:", error.message);
  return data ?? null;
});

/**
 * The league named in the URL and its active season. Both lookups are memoized,
 * so a page calling this after its layouts already have is one cache hit, not
 * another round trip — see lib/league/current.ts.
 *
 * The league is non-null: `[league]/layout.tsx` has already 404'd an unknown
 * slug, and `(public)/layout.tsx` an unpublished one. `notFound()` here is the
 * guard that lets callers say `ctx.league` without a null check.
 */
export async function getActiveContext(slug: string): Promise<ActiveContext> {
  const league = await resolveLeagueBySlug(slug);
  if (!league) notFound();
  return { league, season: await getActiveSeason(league.id) };
}

/**
 * Cookie-selected league and its active season, for the manage tools until they
 * move under `/[league]/manage`. Delete in Step B.
 *
 * @deprecated Use {@link getActiveContext}.
 */
export async function getCookieContext(): Promise<ActiveContext | null> {
  const supabase = await createClient();
  const league = await resolveCurrentLeague(supabase);
  if (!league) return null;
  return { league, season: await getActiveSeason(league.id) };
}

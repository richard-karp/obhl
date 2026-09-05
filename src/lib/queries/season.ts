import { cache } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { resolveLeagueBySlug } from "@/lib/league/current";
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
 * slug, and `(public)/layout.tsx` one this viewer may not see — which since the
 * pages became shared means unpublished AND not theirs, not unpublished alone.
 * `notFound()` here is the guard that lets callers say `ctx.league` without a
 * null check.
 */
export async function getActiveContext(slug: string): Promise<ActiveContext> {
  const league = await resolveLeagueBySlug(slug);
  if (!league) notFound();
  return { league, season: await getActiveSeason(league.id) };
}

/**
 * A manage page's season, plus every season it could be switched to.
 *
 * `is_active` means "what the public site shows" and nothing else. Both
 * importers create seasons with `is_active: false`, so a manage surface keyed
 * on the active season could not edit the season it had just imported — which
 * is what this replaces. The public pages keep `getActiveContext` above.
 */
export type ManageContext = {
  league: League;
  /** Null ONLY when the league has no seasons at all. */
  season: Season | null;
  /** Newest first — the switcher's options, and the fallback's order. */
  seasons: Season[];
};

/**
 * Per-league on purpose. A single `obhl_season` cookie would follow a manager
 * from one league into another, where the id it holds names nothing — and the
 * resolution below would then have to decide between 404 and a silent fallback
 * on every page load. Keyed by league, an id from elsewhere simply isn't read.
 */
export function seasonCookieName(leagueId: string): string {
  return `obhl_season_${leagueId}`;
}

/**
 * Every season of one league, newest first.
 *
 * Read past RLS, like every other manage-side read here. `manages_league`
 * (0032) resolves through `auth_role()`, so a manager whose JWT is missing its
 * role claim reads back nothing — and the switcher would offer an empty list on
 * a page they are otherwise entitled to. Each caller applies its own guard
 * before rendering any of this; nothing is exposed by the query alone.
 *
 * Memoized: several segments ask per render, same as `getActiveSeason`.
 */
const getLeagueSeasons = cache(async function getLeagueSeasons(
  leagueId: string,
): Promise<Season[]> {
  const { data, error } = await createAdminClient()
    .from("seasons")
    .select("*")
    .eq("league_id", leagueId)
    // `nullsFirst: false` so a season with no start date sorts last rather than
    // becoming the league's default. `created_at` breaks a tie, so the fallback
    // is deterministic when two seasons share a start date.
    .order("starts_on", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) console.error("getManageContext (seasons) failed:", error.message);
  return data ?? [];
});

/**
 * The league named in the URL and the season the manage tools are scoped to.
 *
 * Resolution order: an explicit `?season=` → the league's season cookie → the
 * active season → the newest by `starts_on`. The first three are *candidates*,
 * not answers: each is looked up in this league's own season list, so an id
 * from another league — a stale cookie, a link pasted across leagues — falls
 * through to the next candidate, and in the end to this league's own default,
 * instead of 404ing. That validation is the whole reason the list is fetched
 * before the choice is made rather than the id being queried directly.
 *
 * ⚠️ THIS FUNCTION ONLY EVER *READS* THE COOKIE. A Server Component cannot set
 * one — HTTP does not allow a `Set-Cookie` after streaming starts, so
 * `cookies().set()` here throws at runtime. The switcher posts to `selectSeason`
 * (`lib/actions/season-context.ts`), which is a Server Action and may write.
 */
export async function getManageContext(
  slug: string,
  seasonId?: string | null,
): Promise<ManageContext> {
  const league = await resolveLeagueBySlug(slug);
  if (!league) notFound();

  const [seasons, cookieStore] = await Promise.all([
    getLeagueSeasons(league.id),
    cookies(),
  ]);
  const fromCookie = cookieStore.get(seasonCookieName(league.id))?.value;

  // Candidates are resolved against THIS league's seasons, never queried by id.
  const pick = (id: string | null | undefined) =>
    (id && seasons.find((s) => s.id === id)) || null;

  const season =
    pick(seasonId) ??
    pick(fromCookie) ??
    seasons.find((s) => s.is_active) ??
    seasons[0] ??
    null;

  return { league, season, seasons };
}

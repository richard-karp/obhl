import { cache } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { readWithOneRetry } from "@/lib/queries/schedule";
import type { Tables } from "@/lib/db/helpers";
import { resolveSeasonNights } from "@/lib/season/nights";
import { leagueWeekday } from "@/lib/format";

export type League = Tables<"leagues">;
export type Season = Tables<"seasons">;
export type ActiveContext = {
  league: League;
  season: Season | null;
  /** ⛔ `season` is null for no active season and for a failed read; this tells `NoSeason` which. */
  seasonReadFailed: boolean;
};

/** The league's active season. Memoized: several segments ask per render. */
const getActiveSeason = cache(async function getActiveSeason(
  leagueId: string,
): Promise<{ season: Season | null; readFailed: boolean }> {
  const supabase = await createClient();
  const { data, error } = await readWithOneRetry(
    () =>
      supabase
        .from("seasons")
        .select("*")
        .eq("league_id", leagueId)
        .eq("is_active", true)
        .maybeSingle(),
    "active season read",
  );
  if (error) {
    console.error("active season read failed:", error.message);
    return { season: null, readFailed: true };
  }
  // ⚠️ `maybeSingle()` reports no rows as `data: null` with no error, so this arm really is
  // "the league has no active season".
  return { season: data ?? null, readFailed: false };
});

/** `notFound()` here lets callers use `ctx.league` without a null check. Both lookups are memoized. */
export async function getActiveContext(slug: string): Promise<ActiveContext> {
  const league = await resolveLeagueBySlug(slug);
  if (!league) notFound();
  const { season, readFailed } = await getActiveSeason(league.id);
  return { league, season, seasonReadFailed: readFailed };
}

/**
 * `is_active` means only what the public site shows: the importer creates seasons inactive,
 * so a manage page keyed on it could not edit a season it just imported.
 */
export type ManageContext = {
  league: League;
  /** Null ONLY when the league has no seasons at all. */
  season: Season | null;
  /** Newest first — the switcher's options, and the fallback's order. */
  seasons: Season[];
};

/** Per league: a single cookie would follow a manager into a league where its id names nothing. */
export function seasonCookieName(leagueId: string): string {
  return `obhl_season_${leagueId}`;
}

/**
 * Admin client: `manages_league` resolves through `auth_role()`, so a JWT missing its role claim
 * would read nothing. Each caller applies its own guard first.
 */
const getLeagueSeasons = cache(async function getLeagueSeasons(
  leagueId: string,
): Promise<Season[]> {
  // ⚠️ Hoisted out of the factory: only the QUERY has to be rebuilt on a retry, and constructing
  // a second service-role client per attempt is pure waste.
  const admin = createAdminClient();
  const { data, error } = await readWithOneRetry(
    () =>
      admin
        .from("seasons")
        .select("*")
        .eq("league_id", leagueId)
        // A season with no start date sorts last rather than becoming the default; `created_at`
        // breaks a tie so the fallback is deterministic.
        .order("starts_on", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false }),
    "league seasons read",
  );
  // ⚠️ Still flattens a failed read to "no seasons": `ManageContext.season` has 23 call sites that read
  // null that way. Staff-only, and the season switcher is the way back out.
  if (error) console.error("league seasons read failed:", error.message);
  return data ?? [];
});

/**
 * `?season=` → cookie → active → newest, each checked against this league's seasons. ⚠️ Only reads
 * the cookie: setting one here throws, so `selectSeason` (a Server Action) writes it.
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

/**
 * ⛔ The only place the published-games fallback applies: a team page's `detail.games` holds only
 * that team's games, and would silently report the season's nights short.
 */
export const seasonNightsFor = cache(async function seasonNightsFor(
  season: Pick<Season, "id" | "game_nights">,
): Promise<number[]> {
  const declared = resolveSeasonNights(season.game_nights, []);
  // ⚠️ An unscheduled or imported season queries on every render. If that matters, write
  // `game_nights` at season creation rather than widening this early return.
  if (declared.length > 0) return declared;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("games")
    .select("scheduled_at")
    .eq("season_id", season.id)
    .eq("is_draft", false)
    .not("scheduled_at", "is", null);
  if (error) {
    // Empty hides every night control, the safe way to be wrong: no picker, rather than one
    // offering nights the season does not play.
    console.error("season weekdays read failed:", error.message);
    return [];
  }
  return resolveSeasonNights(
    [],
    (data ?? [])
      .map((g) => leagueWeekday(g.scheduled_at))
      .filter((d) => d >= 0),
  );
});

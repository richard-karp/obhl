/**
 * Slugs a league may not take.
 *
 * A league lives at `/<slug>`, matched by the `[league]` dynamic segment. Next
 * resolves static segments before dynamic ones, so a league whose slug equals a
 * top-level route is unreachable: `/login` would always be the sign-in page,
 * never the league. There is no error for this — the league simply never
 * resolves, and the manage tools under it go with it.
 *
 * `manage` IS a top-level route: the League Office lives at `/manage/office`,
 * outside `[league]` because it belongs to no league. So the reservation is
 * load-bearing for the same reason as the rest — and it stays load-bearing even
 * though `manage` is no longer a segment inside a league's own URLs.
 *
 * Kept free of server imports so it can be tested directly.
 *
 * Mirrored by the `leagues_slug_not_reserved` constraint in
 * supabase/migrations/0030_league_slug_reserved.sql — leagues are created by
 * hand-written SQL as often as by the importer, so the database is the only
 * place that catches every path. Change both together.
 */
export const RESERVED_LEAGUE_SLUGS = [
  "api",
  "auth",
  "login",
  "manage",
  "_next",
] as const;

export function isReservedLeagueSlug(slug: string): boolean {
  const normalized = slug.trim().toLowerCase();
  return (RESERVED_LEAGUE_SLUGS as readonly string[]).includes(normalized);
}

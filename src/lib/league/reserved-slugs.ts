/**
 * A slug equal to a top-level route never resolves, with no error. Mirrored by the
 * `leagues_slug_not_reserved` constraint, where hand-written SQL is caught too: change both.
 */
export const RESERVED_LEAGUE_SLUGS = [
  "api",
  "auth",
  "login",
  // ⚠️ A top-level route (`/manage/office`): `0030`'s header saying otherwise is stale.
  "manage",
  "set-password",
  "tonight",
  "_next",
] as const;

export function isReservedLeagueSlug(slug: string): boolean {
  const normalized = slug.trim().toLowerCase();
  return (RESERVED_LEAGUE_SLUGS as readonly string[]).includes(normalized);
}

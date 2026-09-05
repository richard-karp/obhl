/**
 * Who may see a league at all, with the lookups taken out.
 *
 * A league is staged before it launches: rows exist, pages are built, and the
 * public must not see any of it yet. That was one line —
 * `if (!league.is_public) notFound()` — and it worked only because the staff
 * pages lived behind their own `/manage/` prefix and never met it.
 *
 * Once a page is SHARED — one URL serving the public a team page and its manager
 * the same team page with editing on it — that line has to become conditional on
 * who is asking. Both directions of getting it wrong are bad, and they are bad in
 * different ways:
 *
 *   - too permissive: an unpublished league leaks to anyone with the URL,
 *     which is the one thing staging exists to prevent;
 *   - too strict: the people building the league are locked out of the pages
 *     they are building, with a 404 that looks like a broken link.
 *
 * Deliberately pure, and deliberately in its own file, for the same reason as
 * `auth/precedence.ts`: `membership.ts` carries `import "server-only"`, which
 * throws outside a request, so the rule could not otherwise be unit tested
 * without mocking this codebase has never needed. The I/O lives in
 * `requireVisibleLeague`; the decision lives here where all four cells can be
 * asserted directly.
 *
 * ⚠️ THIS IS THE APP HALF OF A PAIR, AND THE RLS HALF IS STRICTER TODAY.
 * `resolveLeagueBySlug` reads through RLS, where "public read leagues" exposes
 * only `is_public` rows and "manager write leagues" (0032) is
 * `manages_league(id)` — the league_manager role AND membership. So a staged
 * league resolves for its MANAGERS and the office, and a scorekeeper or captain
 * who is a member of it gets `null` and a 404 one layer above this, never
 * reaching the rule below. `isMember` here is therefore the ceiling, not the
 * floor: widening this function alone widens nothing. That asymmetry is safe —
 * both halves must say yes — but do not read a `true` from here as proof that
 * someone can see the page.
 */
export function decideLeagueVisible(
  isPublic: boolean,
  isMember: boolean,
): boolean {
  return isPublic || isMember;
}

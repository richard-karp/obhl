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
 * ⚠️ THIS IS THE APP HALF OF A PAIR, AND THE HALVES NOW SAY THE SAME THING.
 * `resolveLeagueBySlug` reads through RLS. Until 0039 the only select paths on
 * `leagues` were "public read leagues" (`using (is_public)`, 0008) and "manager
 * write leagues" (`manages_league(id)`, 0032) — so a staged league resolved for
 * its MANAGERS and the office only, and a scorekeeper or captain who genuinely
 * belonged to it got `null` and a 404 one layer above this, on the league they
 * were staffing. The `isMember` term here was unreachable: a ceiling, not a
 * floor.
 *
 * 0039 adds "member read leagues" — `for select using is_league_member(id)` —
 * so both halves are now the same rule written twice, which is what this
 * codebase does with a rule that matters (`may_write_profile` /
 * `mayWriteProfileOf`).
 *
 * 0040 then widened the child tables the same way — a second `member read`
 * policy per table rather than a redefined `_is_public` helper — so a member of
 * a staged league now reaches the league AND finds it populated. Before 0040
 * they passed this check and got an empty page, which is why the two migrations
 * are one decision split across two files.
 *
 * ⛔ REVIEW THEM AS A PAIR. Widening this function alone
 * no longer widens nothing; it widens the app half of a rule whose RLS half has
 * to be widened with it, or the two disagree in the direction that locks people
 * out silently. Narrowing either half alone is the same mistake mirrored.
 */
export function decideLeagueVisible(
  isPublic: boolean,
  isMember: boolean,
): boolean {
  return isPublic || isMember;
}

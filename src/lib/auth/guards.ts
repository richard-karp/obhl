import { redirect } from "next/navigation";
import { getSessionUser, type AppRole, type SessionUser } from "./session";
import { isLeagueMember } from "./membership";

/** Redirects to /login if not signed in. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

/** Redirects to the league picker if signed in but lacking one of the given roles. */
export async function requireRole(...roles: AppRole[]): Promise<SessionUser> {
  const user = await requireUser();
  // Not /<league>/manage/dashboard: a guard has no league in hand, and the
  // picker is the one page that needs none.
  if (!user.role || !roles.includes(user.role)) redirect("/");
  return user;
}

/** The rest parameter shape of the role guards, for wrappers that forward it. */
export type AppRoleList = [AppRole, ...AppRole[]];

export function requireManager() {
  return requireRole("league_manager");
}

/**
 * A league to check against: an id in hand, or a lookup to run only if the
 * caller clears the role check first.
 *
 * Actions hold an entity id and have to resolve the league from it. Passing the
 * resolved id meant the lookup ran BEFORE the role check — so an unauthenticated
 * request still cost an admin-client query on its way to /login. Passing the
 * lookup instead keeps the cheap check first.
 */
export type LeagueRef = string | null | undefined | (() => Promise<string | null>);

const resolveLeague = async (ref: LeagueRef) =>
  typeof ref === "function" ? await ref() : ref;

/**
 * Role AND membership of this league (`profile_leagues`, 0032).
 *
 * The role guards above answer "may this account do this kind of thing", which
 * used to be the whole question because roles were instance-wide: a scorekeeper
 * for one league could open the other league's scoresheet and score its games.
 * This adds "…in this league", which is the half that was missing.
 *
 * The league id has to come from the caller, and every manage page has it — the
 * league is in the route, and `resolveLeagueBySlug` is `cache()`-wrapped, so
 * resolving it is a cache hit rather than another query. Actions that hold only
 * an entity id resolve the league through `lib/league/of-entity`.
 *
 * Refusal is the same redirect as a wrong role: to the picker, which is the one
 * page that needs no league. A member of nothing therefore lands somewhere that
 * still works, rather than on a 404 that looks like a broken link.
 */
export async function requireLeagueRole(
  league: LeagueRef,
  ...roles: AppRole[]
): Promise<SessionUser> {
  const user = await requireRole(...roles);
  if (!(await isLeagueMember(user.id, await resolveLeague(league)))) redirect("/");
  return user;
}

export function requireLeagueManager(league: LeagueRef) {
  return requireLeagueRole(league, "league_manager");
}

/**
 * Manager of the one league that EVERY id names.
 *
 * For an action that writes with more than one id. Checking each id's league
 * separately is not enough: a person who manages both leagues passes two
 * membership checks while binding one league's team into the other's season,
 * because nothing asks whether the ids agree. Requiring a single league is what
 * closes that, and it is the same answer for a manager of one league — their
 * ids have to agree too.
 *
 * An id that resolves to nothing is a refusal, so a stale or invented id fails
 * closed rather than dropping out of the comparison.
 */
export async function requireLeagueManagerOf(
  ...refs: Array<() => Promise<string | null>>
): Promise<SessionUser> {
  const user = await requireManager();
  const [first, ...rest] = await Promise.all(refs.map((ref) => ref()));
  if (!first || rest.some((id) => id !== first)) redirect("/");
  if (!(await isLeagueMember(user.id, first))) redirect("/");
  return user;
}

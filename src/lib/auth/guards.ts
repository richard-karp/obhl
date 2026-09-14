import { notFound, redirect } from "next/navigation";
import { getSessionUser, type AppRole, type SessionUser } from "./session";
import { isLeagueMember } from "./membership";
import { officeTierOf } from "./office";
import { decideLeagueVisible } from "@/lib/league/visibility";
import type { Tables } from "@/lib/db/helpers";

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(...roles: AppRole[]): Promise<SessionUser> {
  const user = await requireUser();
  // Refusal goes to the picker, not /<league>/dashboard: a guard has no league in hand.
  if (!user.role || !roles.includes(user.role)) redirect("/");
  return user;
}

export type AppRoleList = [AppRole, ...AppRole[]];

export function requireManager() {
  return requireRole("league_manager");
}

/**
 * A league id, or a lookup that runs only after the role check passes, so an
 * unauthenticated request costs no admin-client query on its way to /login.
 */
export type LeagueRef =
  string | null | undefined | (() => Promise<string | null>);

const resolveLeague = async (ref: LeagueRef) =>
  typeof ref === "function" ? await ref() : ref;

/**
 * Role AND membership (`profile_leagues`): `role` is instance-wide. An action
 * holding only an entity id resolves the league through `lib/league/of-entity`.
 */
export async function requireLeagueRole(
  league: LeagueRef,
  ...roles: AppRole[]
): Promise<SessionUser> {
  const user = await requireRole(...roles);
  if (!(await isLeagueMember(user.id, await resolveLeague(league))))
    redirect("/");
  return user;
}

export function requireLeagueManager(league: LeagueRef) {
  return requireLeagueRole(league, "league_manager");
}

/**
 * One league for EVERY id: separate checks let a manager of both leagues bind one
 * league's team into the other's season. An id resolving to nothing refuses.
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

/**
 * ⛔ Every office action calls `requireCommissioner` itself: a page that draws the
 * controls only for a commissioner restricts nothing (`RUNBOOK.md` → Access control).
 */
export async function requireOfficeMember(): Promise<SessionUser> {
  const user = await requireUser();
  if (!(await officeTierOf(user.id))) redirect("/");
  return user;
}

/**
 * A deputy may view the office and change nothing. The tier is checked directly:
 * `mayWriteProfileOf` answers for profiles, and appointing writes `league_office`.
 */
export async function requireCommissioner(): Promise<SessionUser> {
  const user = await requireUser();
  if ((await officeTierOf(user.id)) !== "commissioner") redirect("/");
  return user;
}

/**
 * `notFound()`, never a redirect: a staged league must look like an untaken slug.
 * `(manage)` pages skip this; their guards are stronger, and it would 404 the staff.
 */
export async function requireVisibleLeague(
  league: Tables<"leagues">,
): Promise<void> {
  const user = await getSessionUser();
  const member = user ? await isLeagueMember(user.id, league.id) : false;
  if (!decideLeagueVisible(league.is_public, member)) notFound();
}

/**
 * ⛔ A question, not a guard: it decides what a shared page draws, and every action
 * behind it still calls its own guard (`RUNBOOK.md` → Access control).
 */
export async function canManageLeague(leagueId: string): Promise<boolean> {
  return await hasLeagueRole(leagueId, "league_manager");
}

/**
 * Also a question, not a guard. ⚠️ Not captains, though the scoresheet admits them:
 * a Score button on every public game would suggest a scope they do not have.
 */
export async function canScoreLeague(leagueId: string): Promise<boolean> {
  return await hasLeagueRole(leagueId, "scorekeeper", "league_manager");
}

async function hasLeagueRole(
  leagueId: string,
  ...roles: AppRole[]
): Promise<boolean> {
  const user = await getSessionUser();
  if (!user?.role || !roles.includes(user.role)) return false;
  return await isLeagueMember(user.id, leagueId);
}

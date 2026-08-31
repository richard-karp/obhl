import { redirect } from "next/navigation";
import { getSessionUser, type AppRole, type SessionUser } from "./session";

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

export function requireManager() {
  return requireRole("league_manager");
}

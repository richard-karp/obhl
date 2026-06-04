import { redirect } from "next/navigation";
import { getSessionUser, type AppRole, type SessionUser } from "./session";

/** Redirects to /login if not signed in. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

/** Redirects to /dashboard if signed in but lacking one of the given roles. */
export async function requireRole(...roles: AppRole[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.role || !roles.includes(user.role)) redirect("/dashboard");
  return user;
}

export function requireManager() {
  return requireRole("league_manager");
}

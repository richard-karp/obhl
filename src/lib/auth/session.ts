// Client components import `AppRole` with `import type`; `server-only` makes dropping
// `type` a build error instead of silently bundling `next/headers` for the browser.
import "server-only";
import { cache } from "react";
import { createClient } from "@/utils/supabase/server";

export type AppRole = "league_manager" | "captain" | "scorekeeper";

export type SessionUser = {
  id: string;
  email: string | null;
  role: AppRole | null;
};

/**
 * ⛔ The lockout fix: a token minted while the hook was off has no role claim (`RUNBOOK.md` →
 * Setting up a hosted instance). The RLS client suffices: `own profile read` needs no role.
 */
const roleFromProfile = cache(async function roleFromProfile(
  id: string,
): Promise<AppRole | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", id)
    .maybeSingle();
  return data?.role ?? null;
});

/**
 * The role from the JWT claim, else `profiles`. Memoized per request: a layout, its
 * header and the page each ask independently.
 */
export const getSessionUser = cache(
  async function getSessionUser(): Promise<SessionUser | null> {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    const claims = data?.claims as
      | { sub?: string; email?: string; app_metadata?: { role?: AppRole } }
      | undefined;
    if (error || !claims?.sub) return null;
    const claimed = claims.app_metadata?.role ?? null;
    return {
      id: claims.sub,
      email: claims.email ?? null,
      role: claimed ?? (await roleFromProfile(claims.sub)),
    };
  },
);

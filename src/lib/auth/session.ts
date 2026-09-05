// Client components import `AppRole` from here with `import type`, which erases.
// Dropping that keyword would pull `next/headers` into the browser bundle with no
// build error to say so; this makes it one. Matches `membership.ts` and
// `office.ts`, whose siblings-in-purpose it otherwise was not.
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
 * The role from `profiles`, for a session whose JWT carries no role claim.
 *
 * ⛔ THIS IS THE LOCKOUT FIX, AND IT IS DELIBERATELY ON THE READ SIDE.
 *
 * `app_metadata.role` is written by the custom-access-token hook (`0010`). If
 * that hook did not fire when the token was minted — it is enabled in the
 * Supabase dashboard, not in a migration, so a restored project or a fresh
 * environment can simply not have it — the account signs in with `role: null`
 * and `requireRole` refuses it at every manage page: present in `profiles` with
 * the right role, locked out of the tools, and no error anywhere. That is the
 * standing lockout risk in `LAUNCH_READINESS_HANDOFF.md`.
 *
 * Fixing it here rather than in the hook is a choice: this repairs tokens that
 * have ALREADY been issued, needs no dashboard action, and cannot break sign-in
 * for the accounts that work today. The hook and the `app_role` enum stay
 * untouched.
 *
 * ⚠️ NORMAL RLS CLIENT, NOT THE ADMIN ONE. `own profile read`
 * (`0009_rls_roles.sql:111`) is `for select using (id = auth.uid())` — it does
 * not call `auth_role()`, so a session with no role claim can still read its own
 * row and there is no recursion to break. Reaching past RLS for a row the caller
 * already owns would be widening the blast radius for nothing. (`officeTierOf`
 * uses the admin client for the opposite reason: 0034 grants `league_office` to
 * nobody, so RLS cannot answer it at all.)
 *
 * ⚠️ `cache()` IS NOT OPTIONAL. `getSessionUser` is called by several segments
 * per render — layout, page, and any action they submit to — so an uncached
 * fallback would be one round trip each. Memoized per request; the answer cannot
 * change mid-render.
 *
 * This changes what the app OFFERS, not what the database ACCEPTS. RLS still
 * authorizes every write through `auth_role()`, which reads `profiles` itself.
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
 * Resolves the current user + role from the verified JWT claims. The role comes
 * from the custom-access-token hook (app_metadata.role) for cheap gating, and
 * falls back to `profiles` when the claim is absent (see `roleFromProfile`); RLS
 * still authorizes writes against the profiles table.
 *
 * Memoized per request, like `memberLeagueIds` and `resolveLeagueBySlug`, and
 * for the same reason: layouts cannot hand data to the pages beneath them, so a
 * layout, its header and the page each ask independently. Without this a single
 * public page render built three Supabase clients and verified the same JWT
 * three times. The answer cannot change mid-render.
 */
export const getSessionUser = cache(
  async function getSessionUser(): Promise<SessionUser | null> {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    const claims = data?.claims as
      | { sub?: string; email?: string; app_metadata?: { role?: AppRole } }
      | undefined;
    if (error || !claims?.sub) return null;
    // The claim stays the fast path: a working session costs no extra query, and
    // only a token missing the claim pays for the lookup.
    const claimed = claims.app_metadata?.role ?? null;
    return {
      id: claims.sub,
      email: claims.email ?? null,
      role: claimed ?? (await roleFromProfile(claims.sub)),
    };
  },
);

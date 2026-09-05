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
 * Resolves the current user + role from the verified JWT claims. The role comes
 * from the custom-access-token hook (app_metadata.role) for cheap gating; RLS
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
    return {
      id: claims.sub,
      email: claims.email ?? null,
      role: claims.app_metadata?.role ?? null,
    };
  },
);

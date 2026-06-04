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
 */
export async function getSessionUser(): Promise<SessionUser | null> {
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
}

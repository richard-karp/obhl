import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/utils/supabase/admin";
import type { OfficeTier } from "./precedence";

export type { OfficeTier };

/**
 * Admin client: `0034` grants `league_office` to nobody. ⛔ Never give an office member
 * `profile_leagues` rows: reach is a rule, and removing the tier must restore the old reach.
 */
export const officeTierOf = cache(async function officeTierOf(
  profileId: string,
): Promise<OfficeTier | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("league_office")
    .select("tier")
    .eq("profile_id", profileId)
    .maybeSingle();
  return data?.tier ?? null;
});

/**
 * The whole table on purpose: a league's staff list needs exactly the office members
 * who are not in `profile_leagues`.
 */
export async function listOfficeTiers(): Promise<Map<string, OfficeTier>> {
  const admin = createAdminClient();
  const { data } = await admin.from("league_office").select("profile_id, tier");
  return new Map((data ?? []).map((r) => [r.profile_id, r.tier]));
}

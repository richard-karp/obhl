import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/utils/supabase/admin";
import type { OfficeTier } from "./precedence";

export type { OfficeTier };

/**
 * The League Office tier this profile holds, or null for everyone else
 * (`league_office`, 0034).
 *
 * Read on the admin client, like `memberLeagueIds` and for the same reason: it
 * is an input to the decision about what the caller may see, so it must not be
 * answered through policies that depend on that decision. 0034 grants the table
 * to nobody — not even `select` — so this is the ONLY way to read it, and a
 * session addressing PostgREST directly gets nothing.
 *
 * Memoized per request: a page, its layout and the action it submits to all ask,
 * and the answer cannot change mid-render.
 *
 * ⛔ Membership here is a RULE, not data. An office member has no
 * `profile_leagues` rows, and nothing in this codebase should give them any —
 * see 0034's header for why storing the rule as facts was rejected. The tier is
 * purely additive: appointing touches no membership row, so removing it restores
 * exactly the reach the person had before, with no repair step.
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
 * Every office member, as profile id -> tier.
 *
 * The whole table on purpose. A page listing a league's staff cannot ask for the
 * office members it already knows about, because the ones it needs are precisely
 * the ones NOT in `profile_leagues` — membership there is a rule, not a row. The
 * table is instance-wide staff and peer-flat, appointed only in SQL, so it is a
 * handful of rows by construction.
 */
export async function listOfficeTiers(): Promise<Map<string, OfficeTier>> {
  const admin = createAdminClient();
  const { data } = await admin.from("league_office").select("profile_id, tier");
  return new Map((data ?? []).map((r) => [r.profile_id, r.tier]));
}

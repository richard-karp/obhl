import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/utils/supabase/admin";
import type { LeagueOption } from "@/lib/league/current";

/**
 * League membership — `profile_leagues` (0032). Roles say *what* an account may
 * do; membership says *where*. Both have to hold, and neither implies the other.
 *
 * Read on the admin client on purpose. This is the check that decides whether
 * the caller may see a league at all, so it must not itself be answered through
 * policies that depend on the answer — and every manage page and action that
 * asks already runs privileged reads. RLS is the second, independent half:
 * 0032 puts the same membership test into the policies, so a session hitting
 * PostgREST directly is refused even where no app guard runs.
 *
 * Memoized per request: a page, its layout and the action it submits to all ask
 * the same question, and the answer cannot change mid-render.
 */
export const memberLeagueIds = cache(async function memberLeagueIds(
  profileId: string,
): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("profile_leagues")
    .select("league_id")
    .eq("profile_id", profileId);
  return (data ?? []).map((r) => r.league_id);
});

/** Is this profile a member of this league? A blank league id is never a yes. */
export async function isLeagueMember(
  profileId: string,
  leagueId: string | null | undefined,
): Promise<boolean> {
  if (!leagueId) return false;
  return (await memberLeagueIds(profileId)).includes(leagueId);
}

/** The leagues this profile belongs to, for the manage switcher. */
export async function getMemberLeagues(
  profileId: string,
): Promise<LeagueOption[]> {
  const ids = await memberLeagueIds(profileId);
  if (ids.length === 0) return [];
  const admin = createAdminClient();
  const { data } = await admin
    .from("leagues")
    .select("id, name, slug")
    .in("id", ids)
    .order("created_at", { ascending: true });
  return data ?? [];
}

/**
 * May this actor rewrite the profile of an account that already exists?
 *
 * The app-side twin of 0032's `manager write profiles` policy, and needed
 * because `people.ts` writes on the ADMIN client — the policy's
 * `shares_league_with` test never runs on that path. `profiles.role` is one
 * instance-wide column (0009 reads it as the role source, 0010's hook copies it
 * into the JWT), so a write here lands in EVERY league the account belongs to,
 * not only the league the form was submitted from.
 *
 * The test is therefore CONTAINMENT, not overlap: every league the target works
 * must be one the actor works too. Sharing *a* league is not enough, and 0032's
 * `shares_league_with(id)` is not a second chance for the same reason — adding
 * an existing account at the role it already holds is permitted on purpose and
 * grants membership, so that first step manufactures the very shared league an
 * overlap test looks for, and the write behind it then passes.
 *
 * An account in no league at all passes vacuously, which is what keeps "removed
 * by mistake, add them back" working: `removeStaff` revokes the membership and
 * leaves exactly that shape, and a stricter reading would strand the account
 * with nobody able to re-add it.
 *
 * Both callers have already established that the actor is a manager — and a
 * manager of every league they belong to, since 0009 reads one instance-wide
 * role — so a write that passes this hands out no authority the actor does not
 * already hold.
 */
export async function mayWriteProfileOf(
  actorId: string,
  profileId: string,
): Promise<boolean> {
  const [mine, theirs] = await Promise.all([
    memberLeagueIds(actorId),
    memberLeagueIds(profileId),
  ]);
  return theirs.every((id) => mine.includes(id));
}

/** Grant membership. Idempotent — re-adding an existing member is a no-op. */
export async function addLeagueMembership(
  profileId: string,
  leagueId: string,
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("profile_leagues")
    .upsert({ profile_id: profileId, league_id: leagueId }, {
      onConflict: "profile_id,league_id",
    });
}

/** Revoke membership of ONE league. The account and its other leagues remain. */
export async function removeLeagueMembership(
  profileId: string,
  leagueId: string,
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("profile_leagues")
    .delete()
    .eq("profile_id", profileId)
    .eq("league_id", leagueId);
}

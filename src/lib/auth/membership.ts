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
 * May this actor write the profile of an account that already exists?
 *
 * The app-side twin of 0032's `manager write profiles` policy, and needed
 * because `people.ts` writes on the ADMIN client — the policy's
 * `shares_league_with` test never runs on that path. `profiles.role` is one
 * instance-wide column (0009 reads it as the role source, 0010's hook copies it
 * into the JWT), so without this check a manager rewrites the role, display
 * name and player link an account uses in a league they cannot see.
 *
 * One case is deliberately MORE permissive than the policy: an account that
 * belongs to no league at all is writable by anyone, because there is no other
 * league for the change to land in. That is what keeps "removed by mistake, add
 * them back" working — `removeStaff` revokes the membership and leaves exactly
 * that shape, and a literal reading of the policy would strand the account with
 * nobody able to re-add it.
 */
export async function mayWriteProfileOf(
  actorId: string,
  profileId: string,
): Promise<boolean> {
  const [mine, theirs] = await Promise.all([
    memberLeagueIds(actorId),
    memberLeagueIds(profileId),
  ]);
  return theirs.length === 0 || mine.some((id) => theirs.includes(id));
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

import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/utils/supabase/admin";
import { officeTierOf } from "./office";
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
 *
 * THE OFFICE BRANCH IS THE ONE EDIT THAT DELIVERS CROSS-LEAGUE REACH APP-SIDE.
 * Everything downstream is fed from here — `isLeagueMember` (so every guard),
 * `getMemberLeagues` (the switcher), `mayWriteProfileOf`, and the People page's
 * viewer set — so widening it here widens all of them at once, and there is no
 * second place to keep in step. It mirrors the `my_office_tier() is not null`
 * branch inside 0034's `is_league_member`.
 *
 * "Every league, present and future" is resolved at call time rather than
 * stored, which is the whole reason 0034 rejected giving the office real
 * `profile_leagues` rows: a league created later is included by construction
 * instead of by remembering to backfill it.
 */
export const memberLeagueIds = cache(async function memberLeagueIds(
  profileId: string,
): Promise<string[]> {
  const admin = createAdminClient();

  if (await officeTierOf(profileId)) {
    const { data } = await admin.from("leagues").select("id");
    return (data ?? []).map((r) => r.id);
  }

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

/**
 * The leagues this profile belongs to, for the manage switcher.
 *
 * The office is answered directly rather than through `memberLeagueIds`, which
 * for an office member selects every league id only for this function to ask the
 * same table again for the rows behind them.
 */
export async function getMemberLeagues(
  profileId: string,
): Promise<LeagueOption[]> {
  const admin = createAdminClient();
  const select = () =>
    admin.from("leagues").select("id, name, slug").order("created_at", { ascending: true });

  if (await officeTierOf(profileId)) {
    const { data } = await select();
    return data ?? [];
  }

  const ids = await memberLeagueIds(profileId);
  if (ids.length === 0) return [];
  const { data } = await select().in("id", ids);
  return data ?? [];
}

/**
 * May this actor rewrite the profile of an account that already exists?
 *
 * The app-side twin of 0034's `may_write_profile`, and needed because
 * `people.ts` writes on the ADMIN client — no policy runs on that path.
 * `profiles.role` is one instance-wide column (0009 reads it as the role source,
 * 0010's hook copies it into the JWT), so a write here lands in EVERY league the
 * account belongs to, not only the league the form was submitted from.
 *
 * ⚠️ THIS AND `may_write_profile` (0034) ARE ONE RULE WRITTEN TWICE, and must be
 * reviewed as a pair: the same branches, in the same order. They are the app half
 * and the RLS half of the same question.
 *
 * The rule: YOU MAY WRITE A PROFILE ONLY IF YOUR TIER IS STRICTLY ABOVE THEIRS.
 * Commissioner over everyone but a commissioner; deputy over everyone outside
 * the office; a league manager over tier-0 accounts whose leagues theirs
 * contain. Peers fail at every tier, which is "peers" stated once instead of
 * three times.
 *
 * ⛔ The office is refused EXPLICITLY at tier 0 rather than left to containment.
 * The two halves fail in OPPOSITE directions here, which is exactly why they are
 * written twice and read together:
 *
 *   - In SQL, `contains_leagues_of` reads `profile_leagues` directly. An office
 *     member has no rows, so "is there a league of theirs that is not mine" is
 *     vacuously true and containment PASSES for any caller — the escalation
 *     0034 was probed for.
 *   - Here, `memberLeagueIds` answers for the office with EVERY league, so
 *     containment happens to FAIL instead.
 *
 * Relying on either accident would leave the halves agreeing by luck. The tier
 * comparison below is the actual rule; containment is only the tier-0 test.
 *
 * An account in no league and no tier passes containment vacuously, which is
 * what keeps "removed by mistake, add them back" working: `removeStaff` revokes
 * the membership and leaves exactly that shape.
 */
export async function mayWriteProfileOf(
  actorId: string,
  profileId: string,
): Promise<boolean> {
  const [mineTier, theirTier] = await Promise.all([
    officeTierOf(actorId),
    officeTierOf(profileId),
  ]);

  if (mineTier === "commissioner") return theirTier !== "commissioner";
  if (mineTier === "deputy") return theirTier === null;

  if (theirTier !== null) return false;
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

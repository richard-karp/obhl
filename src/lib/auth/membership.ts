import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/utils/supabase/admin";
import { officeTierOf } from "./office";
import { decideProfileWrite } from "./precedence";
import { leaguesOfPlayer } from "@/lib/league/of-entity";
import type { LeagueOption } from "@/lib/league/current";

/**
 * Admin client on purpose: this decides what the caller may see, so it must not be
 * answered through policies that depend on it. `0032` is the independent RLS half.
 */
export const memberLeagueIds = cache(async function memberLeagueIds(
  profileId: string,
): Promise<string[]> {
  const admin = createAdminClient();

  // This office branch feeds every guard, the switcher and `mayWriteProfileOf`, and
  // mirrors `0034`'s `is_league_member`. Reach is resolved here, never stored as rows.
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

export async function isLeagueMember(
  profileId: string,
  leagueId: string | null | undefined,
): Promise<boolean> {
  if (!leagueId) return false;
  return (await memberLeagueIds(profileId)).includes(leagueId);
}

/**
 * ⚠️ Returns `is_public`: absence from `getPublicLeagues` can be a failed read, not
 * staging. Memoized: `[league]/layout.tsx` calls it on every page under `/<league>`.
 */
export const getMemberLeagues = cache(async function getMemberLeagues(
  profileId: string,
): Promise<Array<LeagueOption & { is_public: boolean }>> {
  const admin = createAdminClient();
  const select = () =>
    admin
      .from("leagues")
      .select("id, name, slug, is_public")
      .order("created_at", { ascending: true });

  if (await officeTierOf(profileId)) {
    const { data } = await select();
    return data ?? [];
  }

  const ids = await memberLeagueIds(profileId);
  if (ids.length === 0) return [];
  const { data } = await select().in("id", ids);
  return data ?? [];
});

/**
 * ⚠️ One rule with `0034`'s `may_write_profile` (`people.ts` writes on the admin client):
 * keep every branch, even ones today's callers can't reach, and review the two as a pair.
 */
export async function mayWriteProfileOf(
  actorId: string,
  profileId: string,
): Promise<boolean> {
  const [mineTier, theirTier] = await Promise.all([
    officeTierOf(actorId),
    officeTierOf(profileId),
  ]);

  // ⛔ The office is decided by tier, never containment: in SQL containment passes for an
  // office member vacuously (no rows), and here it fails. Neither accident is the rule.
  if (mineTier !== null) return decideProfileWrite(mineTier, theirTier, false);
  if (theirTier !== null) return decideProfileWrite(null, theirTier, false);

  // An account in no league passes vacuously, which keeps "removed by mistake, add them back" working.
  const [mine, theirs] = await Promise.all([
    memberLeagueIds(actorId),
    memberLeagueIds(profileId),
  ]);
  return decideProfileWrite(
    null,
    null,
    theirs.every((id) => mine.includes(id)),
  );
}

/**
 * ⛔ Not `mayWriteProfileOf`: `players` is global, so a rename lands in every league the
 * player plays, and each must be the actor's. An unrostered player passes vacuously.
 */
export async function mayWritePlayer(
  actorId: string,
  playerId: string,
): Promise<boolean> {
  const admin = createAdminClient();
  // ⛔ `memberLeagueIds`, never a direct `profile_leagues` query: office members have no
  // rows, so it would refuse the commissioner the refusal message sends managers to.
  const [mine, theirs] = await Promise.all([
    memberLeagueIds(actorId),
    leaguesOfPlayer(playerId, admin),
  ]);
  return theirs.every((id) => mine.includes(id));
}

/**
 * ⛔ Containment, not overlap: `is_captain_of` (0038) authorizes from `player_id` alone, so
 * a player also rostered elsewhere would hand the new login that league's lineup writes.
 */
export async function mayLinkPlayer(
  actorId: string,
  playerId: string,
  leagueId: string,
  admin: ReturnType<typeof createAdminClient>,
): Promise<"ok" | "not_in_league" | "plays_elsewhere"> {
  const theirs = await leaguesOfPlayer(playerId, admin);
  if (!theirs.includes(leagueId)) return "not_in_league";

  const mineTier = await officeTierOf(actorId);
  if (mineTier !== null) {
    return decideProfileWrite(mineTier, null, false) ? "ok" : "plays_elsewhere";
  }

  const mine = await memberLeagueIds(actorId);
  return decideProfileWrite(
    null,
    null,
    theirs.every((id) => mine.includes(id)),
  )
    ? "ok"
    : "plays_elsewhere";
}

export async function addLeagueMembership(
  profileId: string,
  leagueId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const admin = createAdminClient();
  const { error } = await admin.from("profile_leagues").upsert(
    { profile_id: profileId, league_id: leagueId },
    {
      onConflict: "profile_id,league_id",
    },
  );
  // ⛔ supabase-js reports a failure instead of throwing, so return it: a league whose
  // creator is not a member is one nobody can open, and nothing else would notice.
  return { ok: !error, error: error?.message ?? null };
}

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

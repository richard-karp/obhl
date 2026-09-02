"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import {
  addLeagueMembership,
  removeLeagueMembership,
} from "@/lib/auth/membership";
import type { AppRole } from "@/lib/auth/session";

export type PeopleActionState = { ok: boolean; message: string } | null;

const ROLES: AppRole[] = ["league_manager", "captain", "scorekeeper"];

/**
 * Whether the account being acted on is itself a manager.
 *
 * Manager accounts cannot be DEMOTED from this page. Every manager can reach
 * it, so without this any one of them could unmake any other — including the
 * person who set the league up, and including themselves.
 *
 * Removing a manager from a league is a different question and is allowed; see
 * `removeStaff`. Promoting someone to manager still works too. It is unmaking
 * one that is refused — do that by hand, deliberately, in SQL.
 *
 * The UI does not render the role control for a manager row, so reaching this
 * guard means a hand-made request. It returns quietly rather than throwing —
 * there is nowhere to put a message on a form action that returns void.
 */
async function isManagerAccount(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
): Promise<boolean> {
  const { data } = await admin
    .from("profiles")
    .select("role")
    .eq("id", id)
    .maybeSingle();
  return data?.role === "league_manager";
}

/**
 * Is this account a member of the league the form was submitted from?
 *
 * People & Roles used to list every profile in the instance and act on any of
 * them. Each action now derives its league from the form and refuses an id
 * outside it, so a manager of one league cannot reach into another's staff even
 * with a hand-made request.
 */
async function isMemberOf(
  admin: ReturnType<typeof createAdminClient>,
  profileId: string,
  leagueId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("profile_leagues")
    .select("profile_id")
    .eq("profile_id", profileId)
    .eq("league_id", leagueId)
    .maybeSingle();
  return !!data;
}

/**
 * Manager adds a staff account to THIS league — creating the login if the
 * person doesn't have one yet, and granting membership either way.
 *
 * Membership is the point: a role with no league reaches nothing. Adding an
 * address that already has an account is therefore a normal, useful outcome
 * (that is how one person works both leagues), not a collision.
 */
export async function createStaffAccount(
  _prev: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const leagueId = String(formData.get("league_id") ?? "");
  if (!leagueId) return { ok: false, message: "No league selected." };
  await requireLeagueManager(leagueId);

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "") as AppRole;
  const playerId = String(formData.get("player_id") ?? "") || null;
  const displayName = String(formData.get("display_name") ?? "").trim() || email;

  if (!email || !ROLES.includes(role)) {
    return { ok: false, message: "Email and a valid role are required." };
  }
  if (role === "captain" && !playerId) {
    return { ok: false, message: "Link the captain to a player." };
  }

  const admin = createAdminClient();
  let userId: string | undefined;
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error) {
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    userId = list.users.find((u) => u.email === email)?.id;
    if (!userId) return { ok: false, message: error.message };
  } else {
    userId = created.user.id;
  }

  // "Add a staff account" reaches an *existing* account too: createUser fails
  // for a known email, and the id is then looked up and its profile upserted.
  // Submitting a manager's email here would therefore rewrite their role,
  // display name and player link — the same demotion updateStaffRole refuses,
  // through the form sitting directly under the table that lists every
  // manager's address.
  //
  // Adding an existing manager AS a manager is the exception, and it is the
  // whole point of the membership model: it grants them this league without
  // touching their profile. That is how a second manager is handed a league,
  // and it is bounded — the guard above means the granter is already in it.
  if (await isManagerAccount(admin, userId)) {
    if (role !== "league_manager") {
      return {
        ok: false,
        message: `${email} is a manager account. Managers are changed by hand.`,
      };
    }
    await addLeagueMembership(userId, leagueId);
    revalidatePath("/[league]/manage/people", "page");
    return { ok: true, message: `${email} now manages this league too.` };
  }

  const { error: pErr } = await admin.from("profiles").upsert({
    id: userId,
    role,
    // Only written when one was submitted. Nulling it for every non-captain
    // role is what severed a captain's player link the moment they were made a
    // manager or scorekeeper — and a person can be both.
    ...(playerId ? { player_id: playerId } : {}),
    display_name: displayName,
  });
  if (pErr) return { ok: false, message: pErr.message };

  await addLeagueMembership(userId, leagueId);

  revalidatePath("/[league]/manage/people", "page");
  return { ok: true, message: `${email} added as ${role.replace("league_", "")}.` };
}

/** Manager changes the role of someone already in this league. */
export async function updateStaffRole(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  if (!leagueId) return;
  await requireLeagueManager(leagueId);

  const id = String(formData.get("id"));
  const role = String(formData.get("role")) as AppRole;
  if (!ROLES.includes(role)) return;
  const admin = createAdminClient();
  if (!(await isMemberOf(admin, id, leagueId))) return;
  if (await isManagerAccount(admin, id)) return;
  // Role only. This used to null `player_id` for any non-captain role, so
  // promoting a captain to manager quietly unlinked them from their player —
  // and the captain surface is derived from that link.
  await admin.from("profiles").update({ role }).eq("id", id);
  revalidatePath("/[league]/manage/people", "page");
}

/**
 * Manager removes someone from THIS league.
 *
 * This used to call `auth.admin.deleteUser`, which does not come back — from a
 * page that listed every profile in the instance, so a manager of one league
 * could delete another league's staff outright. Revoking the one membership is
 * the league-scoped equivalent and is reversible: the account, its role, its
 * player link and its other leagues all survive.
 *
 * A manager CAN be removed, unlike demotion. Handing out a second manager
 * account is the flow this whole model exists for, and while Remove deleted the
 * account there was no safe way to undo it; now that it only revokes one
 * league, refusing would leave that grant a one-way door with SQL as the only
 * way back.
 *
 * Removing YOURSELF is refused — it would drop you out of a league you may be
 * the only way back into. That one rule is also what keeps a league from ever
 * reaching zero managers, so there is no separate "last manager" check: the
 * caller here is always a manager AND a member of this league, so if the target
 * is a different manager of it the league has at least two, and if the target
 * is its only manager then the target is the caller.
 */
export async function removeStaff(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  if (!leagueId) return;
  const actor = await requireLeagueManager(leagueId);

  const id = String(formData.get("id"));
  const admin = createAdminClient();
  if (!(await isMemberOf(admin, id, leagueId))) return;
  if (id === actor.id) return;
  await removeLeagueMembership(id, leagueId);
  revalidatePath("/[league]/manage/people", "page");
}

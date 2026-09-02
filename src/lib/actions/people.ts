"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import {
  addLeagueMembership,
  mayWriteProfileOf,
  removeLeagueMembership,
} from "@/lib/auth/membership";
import type { AppRole } from "@/lib/auth/session";

export type PeopleActionState = { ok: boolean; message: string } | null;

const ROLES: AppRole[] = ["league_manager", "captain", "scorekeeper"];

/**
 * What an account looks like before an action changes it.
 *
 * Read once and used twice: the manager guard above turns on `role`, and the
 * audit entry needs the same value as `old_data` plus a name, so that the log
 * reads as "Made Alex Chen a scorekeeper" rather than two opaque uuids.
 */
async function staffSnapshot(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
): Promise<{ role: string | null; display_name: string | null } | null> {
  const { data } = await admin
    .from("profiles")
    .select("role, display_name")
    .eq("id", id)
    .maybeSingle();
  return data ? { role: data.role, display_name: data.display_name } : null;
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
 * One audit entry for a staff change.
 *
 * `entity_id` is the LEAGUE id, not the profile id. A person spans leagues, so
 * a profile id names no single one, and what changed here is *this league's*
 * staff. `leagueOfEntity` in `src/lib/audit.ts` resolves `"league_staff"` the
 * same way — without that case the entry is written with a null league, which
 * RLS and every league-scoped view then hide, so it would be correct and
 * invisible.
 *
 * Awaited rather than voided: a `void` promise can be left unfinished when the
 * runtime freezes the function after the response, and who was granted or
 * revoked access to a league is the last record worth losing. `logAudit`
 * swallows its own errors, so awaiting cannot turn a successful change into a
 * reported failure.
 */
async function logStaffChange(
  actorId: string,
  leagueId: string,
  action: "add_staff" | "grant_league" | "update_staff_role" | "remove_staff",
  data: { old_data?: object | null; new_data?: object | null },
) {
  await logAudit({
    user_id: actorId,
    action,
    entity_type: "league_staff",
    entity_id: leagueId,
    ...data,
  });
}

/**
 * The auth user id for an address, or null.
 *
 * Paged rather than one large page: `listUsers` returns a single page and says
 * nothing about the rest, so a lone `perPage: 1000` call turns "this address
 * exists" into "no such account" the moment an instance outgrows it — and the
 * caller then reports the raw createUser error instead of adding the person.
 * The loop stops at the first short page, and at a bound so a backend that
 * ignores paging cannot spin here.
 */
async function findUserIdByEmail(
  admin: ReturnType<typeof createAdminClient>,
  email: string,
): Promise<string | null> {
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) return null;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < perPage) return null;
  }
  return null;
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
  const actor = await requireLeagueManager(leagueId);

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
  // Whether this address already had a login decides what may be written below:
  // a brand-new account has no role anywhere to overwrite.
  let existed = false;
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error) {
    existed = true;
    const found = await findUserIdByEmail(admin, email);
    if (!found) return { ok: false, message: error.message };
    userId = found;
  } else {
    userId = created.user.id;
  }

  // ⛔ An EXISTING account's role is never rewritten here.
  //
  // `profiles.role` is one account-wide column (`0003_membership.sql`): the JWT
  // hook copies it (`0010`) and RLS resolves it through `auth_role()` (`0009`).
  // Writing it from this page therefore changes what that person may do in
  // *every* league they belong to. And this is the one action in this file that
  // never calls `isMemberOf` — the address is typed in, so the target need have
  // no connection to this league at all.
  //
  // Together those let a manager of one league hand `league_manager` to an
  // account whose only league they cannot reach, through the ordinary form with
  // no tampering. `e2e/16-league-membership.spec.ts` covers it.
  //
  // Adding an existing account is still how one person works two leagues: it
  // grants membership and leaves the profile untouched.
  const existing = await staffSnapshot(admin, userId);
  if (existing?.role) {
    if (existing.role !== role) {
      const held = existing.role.replace("league_", "");
      return {
        ok: false,
        message:
          existing.role === "league_manager"
            ? `${email} is a manager account. Managers are changed by hand.`
            : `${email} already has an account as ${held}. A role is account-wide, so this form will not change it — add them as ${held}, then change it from their row.`,
      };
    }
    await addLeagueMembership(userId, leagueId);
    await logStaffChange(actor.id, leagueId, "grant_league", {
      new_data: { profile_id: userId, email, role: existing.role },
    });
    revalidatePath("/[league]/manage/people", "page");
    return {
      ok: true,
      message:
        existing.role === "league_manager"
          ? `${email} now manages this league too.`
          : `${email} now works this league too.`,
    };
  }

  // Everything above this line either creates the account or only grants it a
  // league. From here the profile itself is written, and `profiles.role` is
  // instance-wide — so an existing account reachable in a league this manager
  // cannot see would have the role IT uses there rewritten from here, through
  // the ordinary form, with no tampering.
  //
  // Narrow, and easy to mistake for dead code: the branch above returns for
  // every account that already holds a role, so what reaches here is a login
  // that exists with no profile row or a null one. It stays because the write
  // below is instance-wide whatever the row looked like first. The accounts it
  // cannot see are covered twice over — refused above when the role differs,
  // granted only a membership when it matches, and then held by the SAME test in
  // `updateStaffRole`, which is the other way into an instance-wide role write.
  if (existed && !(await mayWriteProfileOf(actor.id, userId))) {
    return {
      ok: false,
      message: `${email} already has an account in a league you don't manage. A manager of that league can add them, or they can be added here once you share one.`,
    };
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
  await logStaffChange(actor.id, leagueId, "add_staff", {
    new_data: { profile_id: userId, email, role, display_name: displayName },
  });

  revalidatePath("/[league]/manage/people", "page");
  return { ok: true, message: `${email} added as ${role.replace("league_", "")}.` };
}

/** Manager changes the role of someone already in this league. */
export async function updateStaffRole(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  if (!leagueId) return;
  const actor = await requireLeagueManager(leagueId);

  const id = String(formData.get("id"));
  const role = String(formData.get("role")) as AppRole;
  if (!ROLES.includes(role)) return;
  const admin = createAdminClient();
  if (!(await isMemberOf(admin, id, leagueId))) return;

  // Read once: the manager guard turns on this role, and the audit entry needs
  // the same value as `old_data`.
  const before = await staffSnapshot(admin, id);

  // A manager cannot be DEMOTED here. Every manager can reach this page, so
  // without this any one of them could unmake any other — including whoever set
  // the league up, and including themselves. Removing a manager from a league
  // is a different question and is allowed (`removeStaff`), and promoting
  // someone TO manager still works; it is unmaking one that is refused, and
  // that is done by hand in SQL.
  //
  // The UI renders no role control on a manager's row, so reaching this means a
  // hand-made request. It returns quietly rather than throwing: there is
  // nowhere to put a message on a form action that returns void.
  if (before?.role === "league_manager") return;

  // ...and no role write here may reach a league the actor cannot see.
  //
  // EVERY role, not only a promotion to manager. `profiles.role` is one
  // instance-wide column, so making this league's captain a scorekeeper takes
  // away their captaincy in the other league they work too — the same
  // cross-league write as a promotion, pointed the other way, and reachable by
  // the same two ordinary submissions with no tampering.
  //
  // Being a member of this league is not enough to authorise any of it, because
  // membership here is exactly what `createStaffAccount` hands out for free when
  // the role matches — which is why `mayWriteProfileOf` tests containment rather
  // than overlap.
  //
  // Quiet, like the demotion above and for the same reason. The page renders no
  // role control at all where this would refuse, so reaching it means a
  // hand-made request.
  if (!(await mayWriteProfileOf(actor.id, id))) return;

  // Role only. This used to null `player_id` for any non-captain role, so
  // promoting a captain to manager quietly unlinked them from their player —
  // and the captain surface is derived from that link.
  const { error } = await admin.from("profiles").update({ role }).eq("id", id);
  if (error) return;
  await logStaffChange(actor.id, leagueId, "update_staff_role", {
    old_data: { profile_id: id, role: before?.role ?? null },
    new_data: { profile_id: id, role, display_name: before?.display_name ?? null },
  });
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

  // Snapshot before the revoke: afterwards the membership row is gone, and the
  // entry is the only thing saying who held this league and in what role.
  const before = await staffSnapshot(admin, id);
  await removeLeagueMembership(id, leagueId);
  await logStaffChange(actor.id, leagueId, "remove_staff", {
    old_data: {
      profile_id: id,
      role: before?.role ?? null,
      display_name: before?.display_name ?? null,
    },
  });
  revalidatePath("/[league]/manage/people", "page");
}

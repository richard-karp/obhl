"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import { findUserIdByEmail } from "@/lib/auth/users";
import { logAudit } from "@/lib/audit";
import {
  addLeagueMembership,
  mayLinkPlayer,
  mayWriteProfileOf,
  removeLeagueMembership,
} from "@/lib/auth/membership";
import { officeTierOf } from "@/lib/auth/office";
import type { AppRole } from "@/lib/auth/session";

export type PeopleActionState = { ok: boolean; message: string } | null;

const ROLES: AppRole[] = ["league_manager", "captain", "scorekeeper"];

/** An account's role and name before a change: guards turn on the role, audit entries need both. */
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

// Every action derives its league from the form and refuses a profile outside it, so a manager of
// one league cannot reach another's staff with a hand-made request.
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

// `entity_id` is the league: `leagueOfEntity` resolves "league_staff" through it, or the entry is
// hidden (`RUNBOOK.md` → Access control → Traps). Awaited: a voided write can be dropped.
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

// Creates the login if needed and grants this league either way: adding an existing account is
// how one person works two leagues, not a collision.
export async function createStaffAccount(
  _prev: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const leagueId = String(formData.get("league_id") ?? "");
  if (!leagueId) return { ok: false, message: "No league selected." };
  const actor = await requireLeagueManager(leagueId);

  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const role = String(formData.get("role") ?? "") as AppRole;
  const playerId = String(formData.get("player_id") ?? "") || null;
  const displayName =
    String(formData.get("display_name") ?? "").trim() || email;

  if (!email || !ROLES.includes(role)) {
    return { ok: false, message: "Email and a valid role are required." };
  }
  if (role === "captain" && !playerId) {
    return { ok: false, message: "Link the captain to a player." };
  }

  const admin = createAdminClient();
  // `is_captain_of` trusts `profiles.player_id` alone, so every league the player is in must be
  // one this manager works (`mayLinkPlayer`): any role, before the first write.
  if (playerId) {
    const link = await mayLinkPlayer(actor.id, playerId, leagueId, admin);
    if (link === "not_in_league") {
      return { ok: false, message: "Pick a player from this league's rosters." };
    }
    if (link === "plays_elsewhere") {
      return {
        ok: false,
        message:
          "That player also plays in a league you don't manage, so you can't link them to an account. A manager of every league they play in, or the League Office, can.",
      };
    }
  }

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

  // ⛔ An existing account's role is never rewritten: `profiles.role` is account-wide and the
  // address is typed in, so it would change what someone does in leagues this manager cannot reach.
  const existing = await staffSnapshot(admin, userId);
  if (existing?.role) {
    if (existing.role !== role) {
      const held = existing.role.replace("league_", "");
      return {
        ok: false,
        message:
          existing.role === "league_manager"
            ? `${email} is a manager account. Managers are changed by a commissioner.`
            : `${email} already has an account as ${held}. A role is account-wide, so this form will not change it — add them as ${held}, then change it from their row.`,
      };
    }
    // ⛔ Checked: the membership is all this branch grants, and supabase-js reports a failure
    // rather than throwing, so an unchecked await looks like success.
    const granted = await addLeagueMembership(userId, leagueId);
    if (!granted.ok)
      return {
        ok: false,
        message: `Couldn't add ${email} to this league: ${granted.error}`,
      };
    await logStaffChange(actor.id, leagueId, "grant_league", {
      new_data: { profile_id: userId, email, role: existing.role },
    });
    revalidatePath("/[league]/people", "page");
    return {
      ok: true,
      message:
        existing.role === "league_manager"
          ? `${email} now manages this league too.`
          : `${email} now works this league too.`,
    };
  }

  // Looks like dead code and is not: a login with no profile row reaches here, and the write
  // below is instance-wide, so containment is checked (`mayWriteProfileOf`, as in `updateStaffRole`).
  if (existed && !(await mayWriteProfileOf(actor.id, userId))) {
    return {
      ok: false,
      message: `${email} already has an account in a league you don't manage. A manager of that league can add them, or they can be added here once you share one.`,
    };
  }

  const { error: pErr } = await admin.from("profiles").upsert({
    id: userId,
    role,
    // Only when submitted: nulling it for other roles severs a captain's player link, and one
    // person can hold both.
    ...(playerId ? { player_id: playerId } : {}),
    display_name: displayName,
  });
  if (pErr) return { ok: false, message: pErr.message };

  // ⛔ Checked: without the membership the new role reaches nothing. ⚠️ Not rolled back: re-running
  // the form finds the account and takes the grant path above.
  const granted = await addLeagueMembership(userId, leagueId);
  if (!granted.ok)
    return {
      ok: false,
      message: `${email} was created but could not be added to this league: ${granted.error}. Add them again to retry — the account is already there.`,
    };
  await logStaffChange(actor.id, leagueId, "add_staff", {
    new_data: { profile_id: userId, email, role, display_name: displayName },
  });

  revalidatePath("/[league]/people", "page");
  return {
    ok: true,
    message: `${email} added as ${role.replace("league_", "")}.`,
  };
}

export async function updateStaffRole(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  if (!leagueId) return;
  const actor = await requireLeagueManager(leagueId);

  const id = String(formData.get("id"));
  const role = String(formData.get("role")) as AppRole;
  if (!ROLES.includes(role)) return;
  const admin = createAdminClient();
  if (!(await isMemberOf(admin, id, leagueId))) return;

  const before = await staffSnapshot(admin, id);

  // A peer manager cannot demote a manager; the League Office can (`mayWriteProfileOf` below still
  // checks rank). Quiet: the UI draws no control here, so only a hand-made request arrives.
  if (before?.role === "league_manager" && !(await officeTierOf(actor.id)))
    return;

  // Any role write, not only a promotion: `profiles.role` is instance-wide and membership here is
  // free to obtain, so `mayWriteProfileOf` tests containment, not overlap.
  if (!(await mayWriteProfileOf(actor.id, id))) return;

  // Role only: `player_id` stays, since the captain surface is derived from that link.
  const { error } = await admin.from("profiles").update({ role }).eq("id", id);
  if (error) return;
  await logStaffChange(actor.id, leagueId, "update_staff_role", {
    old_data: { profile_id: id, role: before?.role ?? null },
    new_data: {
      profile_id: id,
      role,
      display_name: before?.display_name ?? null,
    },
  });
  revalidatePath("/[league]/people", "page");
}

// Revokes one membership, never the account. Self-removal is refused, so a manager cannot empty a
// league; the League Office may, deliberately, since it can appoint the replacement.
export async function removeStaff(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  if (!leagueId) return;
  const actor = await requireLeagueManager(leagueId);

  const id = String(formData.get("id"));
  const admin = createAdminClient();
  if (!(await isMemberOf(admin, id, leagueId))) return;
  if (id === actor.id) return;

  // ⛔ Never an office member: their membership is a rule, not a row, so the revoke would do
  // nothing and the audit entry would record a removal that did not happen.
  if (await officeTierOf(id)) return;

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
  revalidatePath("/[league]/people", "page");
}

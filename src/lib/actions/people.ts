"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import type { AppRole } from "@/lib/auth/session";

export type PeopleActionState = { ok: boolean; message: string } | null;

const ROLES: AppRole[] = ["league_manager", "captain", "scorekeeper"];

/**
 * Whether the account being acted on is itself a manager.
 *
 * Manager accounts are deliberately not editable from this page. Every manager
 * can reach it, so without this any one of them could demote or delete any
 * other — including the person who set the league up, and including themselves.
 * `removeStaff` calls `auth.admin.deleteUser`, which does not come back.
 *
 * Promoting someone to manager still works; it is unmaking one that is refused.
 * Do that by hand, deliberately, in SQL.
 *
 * The UI does not render these controls for a manager row, so reaching this
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


/** Manager creates a staff account (and its profile/role) via the admin API. */
export async function createStaffAccount(
  _prev: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  await requireManager();

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
  // display name and player link — the same demotion updateStaffRole and
  // removeStaff refuse, through the form sitting directly under the table that
  // lists every manager's address.
  if (await isManagerAccount(admin, userId)) {
    return role === "league_manager"
      ? { ok: true, message: `${email} is already a manager — nothing to change.` }
      : {
          ok: false,
          message: `${email} is a manager account. Managers are changed by hand.`,
        };
  }

  const { error: pErr } = await admin.from("profiles").upsert({
    id: userId,
    role,
    player_id: role === "captain" ? playerId : null,
    display_name: displayName,
  });
  if (pErr) return { ok: false, message: pErr.message };

  revalidatePath("/[league]/manage/people", "page");
  return { ok: true, message: `${email} added as ${role.replace("league_", "")}.` };
}

/** Manager changes an existing user's role. */
export async function updateStaffRole(formData: FormData) {
  await requireManager();
  const id = String(formData.get("id"));
  const role = String(formData.get("role")) as AppRole;
  if (!ROLES.includes(role)) return;
  const admin = createAdminClient();
  if (await isManagerAccount(admin, id)) return;
  await admin
    .from("profiles")
    .update({ role, player_id: role === "captain" ? undefined : null })
    .eq("id", id);
  revalidatePath("/[league]/manage/people", "page");
}

/** Manager removes a staff account entirely (profile cascades). */
export async function removeStaff(formData: FormData) {
  await requireManager();
  const id = String(formData.get("id"));
  const admin = createAdminClient();
  if (await isManagerAccount(admin, id)) return;
  await admin.auth.admin.deleteUser(id);
  revalidatePath("/[league]/manage/people", "page");
}

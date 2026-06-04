"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import type { AppRole } from "@/lib/auth/session";

export type PeopleActionState = { ok: boolean; message: string } | null;

const ROLES: AppRole[] = ["league_manager", "captain", "scorekeeper"];

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
    const { data: list } = await admin.auth.admin.listUsers();
    userId = list.users.find((u) => u.email === email)?.id;
    if (!userId) return { ok: false, message: error.message };
  } else {
    userId = created.user.id;
  }

  const { error: pErr } = await admin.from("profiles").upsert({
    id: userId,
    role,
    player_id: role === "captain" ? playerId : null,
    display_name: displayName,
  });
  if (pErr) return { ok: false, message: pErr.message };

  revalidatePath("/people");
  return { ok: true, message: `${email} added as ${role.replace("league_", "")}.` };
}

/** Manager changes an existing user's role. */
export async function updateStaffRole(formData: FormData) {
  await requireManager();
  const id = String(formData.get("id"));
  const role = String(formData.get("role")) as AppRole;
  if (!ROLES.includes(role)) return;
  const admin = createAdminClient();
  await admin
    .from("profiles")
    .update({ role, player_id: role === "captain" ? undefined : null })
    .eq("id", id);
  revalidatePath("/people");
}

/** Manager removes a staff account entirely (profile cascades). */
export async function removeStaff(formData: FormData) {
  await requireManager();
  const id = String(formData.get("id"));
  const admin = createAdminClient();
  await admin.auth.admin.deleteUser(id);
  revalidatePath("/people");
}

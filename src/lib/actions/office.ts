"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireCommissioner } from "@/lib/auth/guards";
import { passwordProblem } from "@/lib/auth/password";
import { officeTierOf } from "@/lib/auth/office";
import { findUserIdByEmail } from "@/lib/auth/users";
import { logAudit } from "@/lib/audit";

// ⛔ Each action calls `requireCommissioner` itself: a control drawn only for a commissioner is not
// a restriction. None touches `profile_leagues`: the tier is additive, so revoking it loses nothing.
export async function appointDeputy(formData: FormData) {
  const actor = await requireCommissioner();

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // Already in the office — including already a commissioner, whom this must
  // never quietly demote to deputy.
  if (await officeTierOf(id)) return;

  const admin = createAdminClient();
  // Snapshot the name first: once the profile is gone the entry is the only record of who this was.
  const { data: before } = await admin
    .from("profiles")
    .select("display_name")
    .eq("id", id)
    .maybeSingle();

  // The insert is the real check: the primary key refuses a concurrent second appointment, and
  // 0034's trigger refuses anyone who is not a `league_manager`.
  const { error } = await admin
    .from("league_office")
    .insert({ profile_id: id, tier: "deputy" });
  if (error) return;

  // ⛔ `entity_type: "office"` files under a null league by decision (`case "office"` in
  // `leagueOfEntity`): one entry, since the tier reaches every league.
  await logAudit({
    user_id: actor.id,
    action: "appoint_deputy",
    entity_type: "office",
    entity_id: id,
    new_data: {
      profile_id: id,
      tier: "deputy",
      display_name: before?.display_name ?? null,
    },
  });

  revalidatePath("/manage/office");
}

export async function removeDeputy(formData: FormData) {
  const actor = await requireCommissioner();

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // ⛔ Deputies only: commissioners are peer-flat, so no app path edits that tier and one
  // compromised office account cannot empty it.
  if ((await officeTierOf(id)) !== "deputy") return;

  const admin = createAdminClient();
  const { data: before } = await admin
    .from("profiles")
    .select("display_name")
    .eq("id", id)
    .maybeSingle();

  // `tier` is in the WHERE too, so a profile made commissioner since the check is not removed.
  const { error } = await admin
    .from("league_office")
    .delete()
    .eq("profile_id", id)
    .eq("tier", "deputy");
  if (error) return;

  await logAudit({
    user_id: actor.id,
    action: "remove_deputy",
    entity_type: "office",
    entity_id: id,
    old_data: {
      profile_id: id,
      tier: "deputy",
      display_name: before?.display_name ?? null,
    },
  });

  revalidatePath("/manage/office");
}

/** Feedback for the set-password form, which cannot afford to refuse quietly. */
export type SetPasswordState = { ok: boolean; message: string } | null;

// ⛔ `requireCommissioner` is called here, not implied by the card: a form action is reachable by
// anyone (`RUNBOOK.md` → Access control; `league-guards.test.ts` fails the build without it).
export async function setStaffPassword(
  _prev: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const actor = await requireCommissioner();

  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email)
    return { ok: false, message: "Enter the account's email address." };
  // The self-serve reset's floor, checked before Supabase: see `@/lib/auth/password`.
  const tooShort = passwordProblem(password);
  if (tooShort) return { ok: false, message: tooShort };

  const admin = createAdminClient();
  // Lowercased here and again inside `findUserIdByEmail`, so neither relies on the other.
  const id = await findUserIdByEmail(admin, email);
  if (!id) {
    return { ok: false, message: `No account for ${email}.` };
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("display_name, role")
    .eq("id", id)
    .maybeSingle();
  if (!profile) {
    return {
      ok: false,
      message: `${email} has a login but no staff profile — add them on a league's People & Roles page first.`,
    };
  }

  // ⛔ Never another commissioner: a password takes the account over, and the tier is peer-flat.
  // Your own is allowed; that is the bootstrap.
  if (id !== actor.id && (await officeTierOf(id)) === "commissioner") {
    return {
      ok: false,
      message:
        "No commissioner can set another commissioner's password. The tier is peer-flat — change it in the database.",
    };
  }

  const { error } = await admin.auth.admin.updateUserById(id, { password });
  if (error) return { ok: false, message: error.message };

  // ⛔ Office entry, null league by decision (`case "office"` in `leagueOfEntity`), read on
  // `/manage/office`. Never put the password in the payload.
  await logAudit({
    user_id: actor.id,
    action: "set_password",
    entity_type: "office",
    entity_id: id,
    new_data: {
      profile_id: id,
      email,
      display_name: profile.display_name ?? null,
    },
  });

  revalidatePath("/manage/office");
  return {
    ok: true,
    message: `Password set for ${email}. Tell them out of band — this page will not show it again.`,
  };
}

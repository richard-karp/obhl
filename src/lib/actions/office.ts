"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireCommissioner } from "@/lib/auth/guards";
import { officeTierOf } from "@/lib/auth/office";
import { findUserIdByEmail } from "@/lib/auth/users";
import { logAudit } from "@/lib/audit";

/**
 * Appoint and remove deputies.
 *
 * ⛔ Both call `requireCommissioner` themselves. The page draws these controls
 * only for a commissioner, but a form action is reachable by anyone who can
 * construct the request — a rendered restriction is not a restriction.
 *
 * ⛔ Neither touches `profile_leagues`. The tier is purely additive: a manager
 * promoted to deputy keeps the rows they had, inert while the office branch of
 * `memberLeagueIds` answers first, so removing the tier restores exactly the
 * reach they had before with no repair step. Deleting their memberships on
 * appointment would make revocation lossy and silent.
 *
 * Both return void, like the other form actions here, so a refusal is quiet.
 * The page renders a reason wherever it would refuse, which is why that is
 * tolerable — see `people.ts` for the same argument at length.
 */

export async function appointDeputy(formData: FormData) {
  const actor = await requireCommissioner();

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // Already in the office — including already a commissioner, whom this must
  // never quietly demote to deputy.
  if (await officeTierOf(id)) return;

  const admin = createAdminClient();
  // The insert is the real check as well as the write. `profile_id` is the
  // primary key, so a second concurrent appointment fails rather than racing,
  // and 0034's trigger refuses anyone who is not a `league_manager` — a
  // commissioner cannot appoint a captain into a tier that would give them
  // nothing but cross-league reach.
  // Snapshot the name BEFORE the write, for the same reason `removeStaff` does:
  // the entry is the only thing that still says who this was once the profile is
  // gone.
  const { data: before } = await admin
    .from("profiles")
    .select("display_name")
    .eq("id", id)
    .maybeSingle();

  const { error } = await admin
    .from("league_office")
    .insert({ profile_id: id, tier: "deputy" });
  if (error) return;

  // ⛔ `entity_type: "office"` resolves to a NULL league, by decision — see the
  // `case "office"` in `leagueOfEntity`. One entry per action, not one per
  // league: the tier reaches all of them.
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

  // ⛔ Deputies only. The commissioner tier is peer-flat — no commissioner
  // outranks another — so it is not editable from the app by anyone, and that is
  // what stops a single compromised office account emptying the tier.
  if ((await officeTierOf(id)) !== "deputy") return;

  const admin = createAdminClient();
  // `tier` is in the WHERE clause as well, so the read above cannot go stale
  // between the check and the delete: if this profile became a commissioner in
  // between, the delete matches nothing instead of removing one.
  const { data: before } = await admin
    .from("profiles")
    .select("display_name")
    .eq("id", id)
    .maybeSingle();

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

/**
 * The shortest password this will set.
 *
 * Supabase's own floor is 6. Eight is not a security theory, it is the number
 * that stops a commissioner handing someone a password Supabase would accept and
 * a browser would autofill into every other box.
 */
const MIN_PASSWORD = 8;

/**
 * Set a staff account's password, as a commissioner.
 *
 * ⛔ THIS IS THE NO-EMAIL RECOVERY PATH, and the bootstrap under it. No staff
 * account has a password today — production's were made for magic-link sign-in —
 * so until someone can SET one, "sign in with a password" has nobody who can.
 * This is that someone. It also covers the case email cannot: a staff member
 * whose address no longer reaches them, or a Supabase mailer that is rate-limited
 * at four messages an hour.
 *
 * ⛔ `requireCommissioner` is called HERE, not implied by the card being drawn
 * for a commissioner. A form action is an endpoint reachable by anyone who can
 * construct the request — the office page renders this card only for a
 * commissioner, and that is a convenience, not a restriction. This is the exact
 * failure mode `ACCESS_CONTROL_HANDOFF.md`'s *Traps* section is about, and
 * `league-guards.test.ts` fails the build for any office action that skips it.
 *
 * ⛔ NEVER ANOTHER COMMISSIONER. Setting a password is taking the account over,
 * so it has to obey the same peer-flat rule as the tier itself: no commissioner
 * outranks another, and one who could reset a peer's password could sign in as
 * them and remove them in SQL-free comfort. Checked on the tier directly, the way
 * `appointDeputy` and `removeDeputy` do — `mayWriteProfileOf` answers who may
 * write a PROFILE, and this writes an auth user.
 *
 * Setting your OWN is allowed, and is the bootstrap: a commissioner who arrived
 * by magic link gives themselves a password so the next sign-in needs no email.
 *
 * A `profiles` row is required, so this is a staff tool rather than a general
 * password reset for any auth user that happens to exist.
 *
 * ⚠️ The password is never audited, only the fact and the target. An audit entry
 * naming it would put a live credential in a table read by every manager of the
 * league it lands in — and this one lands under a null league, read on the admin
 * client, which is worse rather than better.
 */
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
  if (password.length < MIN_PASSWORD) {
    return {
      ok: false,
      message: `Use at least ${MIN_PASSWORD} characters.`,
    };
  }

  const admin = createAdminClient();
  // Lowercased on both sides — `findUserIdByEmail` compares against a lowercased
  // address and a raw one is a miss, not an error.
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

  if (id !== actor.id && (await officeTierOf(id)) === "commissioner") {
    return {
      ok: false,
      message:
        "No commissioner can set another commissioner's password. The tier is peer-flat — change it in the database.",
    };
  }

  const { error } = await admin.auth.admin.updateUserById(id, { password });
  if (error) return { ok: false, message: error.message };

  // ⛔ `entity_type: "office"` — instance-wide, so it resolves to a NULL league by
  // decision (see `case "office"` in `leagueOfEntity`) and is read back on
  // `/manage/office` rather than in any league's log. NO PASSWORD IN THE PAYLOAD.
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

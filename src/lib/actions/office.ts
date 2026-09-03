"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireCommissioner } from "@/lib/auth/guards";
import { officeTierOf } from "@/lib/auth/office";

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
  await requireCommissioner();

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
  const { error } = await admin
    .from("league_office")
    .insert({ profile_id: id, tier: "deputy" });
  if (error) return;

  revalidatePath("/manage/office");
}

export async function removeDeputy(formData: FormData) {
  await requireCommissioner();

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
  const { error } = await admin
    .from("league_office")
    .delete()
    .eq("profile_id", id)
    .eq("tier", "deputy");
  if (error) return;

  revalidatePath("/manage/office");
}

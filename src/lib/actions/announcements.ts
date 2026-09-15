"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import { leagueOfAnnouncement } from "@/lib/league/of-entity";

export type AnnouncementActionState = { ok: boolean; message: string } | null;

export async function createAnnouncement(
  _prev: AnnouncementActionState,
  formData: FormData,
): Promise<AnnouncementActionState> {
  // The posting page's league, from the form rather than a cookie, and guarded
  // rather than trusted: it is a hidden field.
  const league_id = String(formData.get("league_id") ?? "");
  if (!league_id) return { ok: false, message: "No league selected." };
  const user = await requireLeagueManager(league_id);
  const admin = createAdminClient();

  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!title || !body) {
    return { ok: false, message: "Title and body are both required." };
  }

  const { data: posted, error } = await admin
    .from("announcements")
    .insert({
      league_id,
      title,
      body,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, message: error.message };

  // Awaited, not voided: a voided write can be dropped when the runtime freezes
  // after the response, and `logAudit` swallows its own errors.
  await logAudit({
    user_id: user.id,
    action: "create_announcement",
    entity_type: "announcement",
    entity_id: posted.id,
    // No `league_id`: the row exists, so `leagueOfEntity` resolves it (the delete below cannot).
    new_data: { title },
  });

  revalidatePath("/[league]/announcements", "page");
  revalidatePath("/[league]", "page");
  return { ok: true, message: "Announcement posted." };
}

export async function deleteAnnouncement(formData: FormData) {
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  // Resolved eagerly, not through the lazy guard form: the audit entry below needs the
  // league and the row is about to be gone. The cost is one admin query before the role check.
  const league_id = await leagueOfAnnouncement(id, admin);
  const manager = await requireLeagueManager(league_id);

  // Read before the delete: afterwards the row is gone, and this entry is the
  // only thing that says what was taken down.
  const { data: before } = await admin
    .from("announcements")
    .select("title, body, created_at")
    .eq("id", id)
    .maybeSingle();

  await admin.from("announcements").delete().eq("id", id);
  // ⛔ `league_id` passed explicitly: the row is gone, and a null-league entry is hidden
  // from every view (`RUNBOOK.md` → Access control → Traps).
  await logAudit({
    user_id: manager.id,
    action: "delete_announcement",
    entity_type: "announcement",
    entity_id: id,
    league_id,
    old_data: before ?? { title: null },
  });
  revalidatePath("/[league]/announcements", "page");
  revalidatePath("/[league]", "page");
}

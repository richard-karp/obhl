"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";

export type AnnouncementActionState = { ok: boolean; message: string } | null;

/** Post an announcement to the current league. */
export async function createAnnouncement(
  _prev: AnnouncementActionState,
  formData: FormData,
): Promise<AnnouncementActionState> {
  const user = await requireManager();
  const admin = createAdminClient();
  // From the form, not a cookie: this posts to the league whose page it was
  // submitted from. Resolved from the cookie it always picked the oldest
  // league, so an announcement written in one league appeared in another.
  const league_id = String(formData.get("league_id") ?? "");
  if (!league_id) return { ok: false, message: "No league selected." };

  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!title || !body) {
    return { ok: false, message: "Title and body are both required." };
  }

  const { error } = await admin.from("announcements").insert({
    league_id,
    title,
    body,
    created_by: user.id,
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath("/[league]/manage/announcements", "page");
  revalidatePath("/[league]", "page");
  return { ok: true, message: "Announcement posted." };
}

export async function deleteAnnouncement(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  await admin.from("announcements").delete().eq("id", id);
  revalidatePath("/[league]/manage/announcements", "page");
  revalidatePath("/[league]", "page");
}

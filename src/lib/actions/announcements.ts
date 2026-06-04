"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import { resolveCurrentLeague } from "@/lib/league/current";

export type AnnouncementActionState = { ok: boolean; message: string } | null;

/** Post an announcement to the current league. */
export async function createAnnouncement(
  _prev: AnnouncementActionState,
  formData: FormData,
): Promise<AnnouncementActionState> {
  const user = await requireManager();
  const admin = createAdminClient();
  const league = await resolveCurrentLeague(admin);
  if (!league) return { ok: false, message: "No league selected." };

  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!title || !body) {
    return { ok: false, message: "Title and body are both required." };
  }

  const { error } = await admin.from("announcements").insert({
    league_id: league.id,
    title,
    body,
    created_by: user.id,
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath("/announcements");
  revalidatePath("/");
  return { ok: true, message: "Announcement posted." };
}

export async function deleteAnnouncement(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  await admin.from("announcements").delete().eq("id", id);
  revalidatePath("/announcements");
  revalidatePath("/");
}

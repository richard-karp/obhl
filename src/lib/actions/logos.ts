"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";

/** Manager uploads a team logo to Storage and points the team at it. */
export async function uploadTeamLogo(formData: FormData) {
  await requireManager();
  const teamId = String(formData.get("team_id"));
  const file = formData.get("logo") as File | null;
  if (!file || file.size === 0) return;

  const admin = createAdminClient();
  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  const path = `teams/${teamId}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error } = await admin.storage
    .from("logos")
    .upload(path, buffer, {
      contentType: file.type || "image/png",
      upsert: true,
    });
  if (error) return;

  await admin.from("teams").update({ logo_path: path }).eq("id", teamId);
  revalidatePath(`/rosters/${teamId}`);
  revalidatePath("/teams");
}

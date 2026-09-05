"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import { leagueOfTeam } from "@/lib/league/of-entity";

/** Manager uploads a team logo to Storage and points the team at it. */
export async function uploadTeamLogo(formData: FormData) {
  const teamId = String(formData.get("team_id"));
  const admin = createAdminClient();
  const manager = await requireLeagueManager(() => leagueOfTeam(teamId, admin));
  const file = formData.get("logo") as File | null;
  if (!file || file.size === 0) return;

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

  const { data: was } = await admin
    .from("teams")
    .select("logo_path")
    .eq("id", teamId)
    .maybeSingle();
  await admin.from("teams").update({ logo_path: path }).eq("id", teamId);
  // The upload is `upsert: true`, so a replacement overwrites the file in
  // Storage and the old image is gone. `old_data` is then the only record that
  // there was one — the path is the same string when the extension matches.
  await logAudit({
    user_id: manager.id,
    action: "upload_logo",
    entity_type: "team",
    entity_id: teamId,
    old_data: { logo_path: was?.logo_path ?? null },
    new_data: { logo_path: path },
  });
  revalidatePath("/[league]/teams/[slug]", "page");
  revalidatePath("/[league]/teams", "page");
}

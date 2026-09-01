"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import { leagueOfTeam } from "@/lib/league/of-entity";

/** Manager uploads a team logo to Storage and points the team at it. */
export async function uploadTeamLogo(formData: FormData) {
  const teamId = String(formData.get("team_id"));
  const admin = createAdminClient();
  await requireLeagueManager(() => leagueOfTeam(teamId, admin));
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

  await admin.from("teams").update({ logo_path: path }).eq("id", teamId);
  revalidatePath("/[league]/manage/rosters/[teamId]", "page");
  revalidatePath("/[league]/teams", "page");
}

"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import { leagueOfTeam } from "@/lib/league/of-entity";
import { logoFileType } from "@/lib/utils/logo-type";

export type LogoActionState = { ok: boolean; message: string } | null;

export async function uploadTeamLogo(
  _prev: LogoActionState,
  formData: FormData,
): Promise<LogoActionState> {
  const teamId = String(formData.get("team_id"));
  const admin = createAdminClient();
  const manager = await requireLeagueManager(() => leagueOfTeam(teamId, admin));
  const file = formData.get("logo") as File | null;
  if (!file || file.size === 0) {
    return { ok: false, message: "Choose an image file first." };
  }

  const type = logoFileType(file.name);
  if (!type) {
    return { ok: false, message: "Logos must be PNG, JPEG or WebP." };
  }
  const path = `teams/${teamId}.${type.ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error } = await admin.storage.from("logos").upload(path, buffer, {
    contentType: type.contentType,
    upsert: true,
  });
  if (error) {
    return { ok: false, message: `Couldn't upload the logo: ${error.message}` };
  }

  const { data: was } = await admin
    .from("teams")
    .select("logo_path")
    .eq("id", teamId)
    .maybeSingle();
  const { error: tErr } = await admin
    .from("teams")
    .update({ logo_path: path })
    .eq("id", teamId);
  if (tErr) {
    return {
      ok: false,
      message: `Uploaded, but couldn't set it as the team's logo: ${tErr.message}`,
    };
  }

  // A replacement with another extension would leave the old file publicly served, so it is
  // removed: only this team's own file, never whatever a stray `logo_path` names.
  if (
    was?.logo_path &&
    was.logo_path !== path &&
    was.logo_path.startsWith(`teams/${teamId}.`)
  ) {
    await admin.storage.from("logos").remove([was.logo_path]);
  }
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
  return { ok: true, message: "Logo updated." };
}

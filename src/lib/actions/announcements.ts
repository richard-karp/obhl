"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import { leagueOfAnnouncement } from "@/lib/league/of-entity";

export type AnnouncementActionState = { ok: boolean; message: string } | null;

/** Post an announcement to the current league. */
export async function createAnnouncement(
  _prev: AnnouncementActionState,
  formData: FormData,
): Promise<AnnouncementActionState> {
  // From the form, not a cookie: this posts to the league whose page it was
  // submitted from. Resolved from the cookie it always picked the oldest
  // league, so an announcement written in one league appeared in another.
  const league_id = String(formData.get("league_id") ?? "");
  if (!league_id) return { ok: false, message: "No league selected." };
  // …and the form's league is checked, not trusted: it is a hidden field.
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

  // Awaited, not voided, like `people.ts`: a void promise can be left unfinished
  // when the runtime freezes the function after the response. `logAudit`
  // swallows its own errors, so awaiting cannot turn a successful post into a
  // reported failure.
  await logAudit({
    user_id: user.id,
    action: "create_announcement",
    entity_type: "announcement",
    entity_id: posted.id,
    // No explicit `league_id`: the row exists, so `leagueOfEntity` resolves it
    // through `leagueOfAnnouncement`, which is the file's normal path and the
    // only thing that keeps that switch case exercised. The delete below is the
    // documented exception — its row is gone by then.
    new_data: { title },
  });

  revalidatePath("/[league]/manage/announcements", "page");
  revalidatePath("/[league]", "page");
  return { ok: true, message: "Announcement posted." };
}

export async function deleteAnnouncement(formData: FormData) {
  const admin = createAdminClient();
  const id = String(formData.get("id"));
  // Resolved eagerly rather than through the lazy `() => …` guard form, because
  // the audit entry below needs the same answer and the row is about to be
  // gone. `removeRosterPlayer` in `rosters.ts` trades the same way.
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
  // ⛔ `league_id` passed explicitly. `leagueOfEntity` would resolve it from the
  // announcement row, which no longer exists — and an entry with a null league
  // is hidden by RLS and filtered out of every league-scoped view, so it would
  // be written correctly and never appear.
  await logAudit({
    user_id: manager.id,
    action: "delete_announcement",
    entity_type: "announcement",
    entity_id: id,
    league_id,
    old_data: before ?? { title: null },
  });
  revalidatePath("/[league]/manage/announcements", "page");
  revalidatePath("/[league]", "page");
}

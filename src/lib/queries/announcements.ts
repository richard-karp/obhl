import { createClient } from "@/utils/supabase/server";
import { readWithOneRetry } from "@/lib/queries/schedule";
import type { Tables } from "@/lib/db/helpers";

export type Announcement = Tables<"announcements">;

/** ⛔ The home page draws no card when this is empty, so a failed read would be invisible there. */
export type AnnouncementsRead = {
  rows: Announcement[];
  readFailed: boolean;
};

export async function getAnnouncements(
  leagueId: string,
  limit?: number,
): Promise<AnnouncementsRead> {
  const supabase = await createClient();
  // ⛔ A factory, not a builder: an awaited PostgREST builder is spent, so the retry builds anew.
  const { data, error } = await readWithOneRetry(() => {
    const q = supabase
      .from("announcements")
      .select("*")
      .eq("league_id", leagueId)
      .eq("is_published", true)
      .order("published_at", { ascending: false });
    return limit ? q.limit(limit) : q;
  }, "announcements read");
  if (error) {
    console.error("announcements read failed:", error.message);
    return { rows: [], readFailed: true };
  }
  return { rows: data ?? [], readFailed: false };
}

import { createClient } from "@/utils/supabase/server";
import type { Tables } from "@/lib/db/helpers";

export type Announcement = Tables<"announcements">;

/** Published announcements for a league, newest first. */
export async function getAnnouncements(
  leagueId: string,
  limit?: number,
): Promise<Announcement[]> {
  const supabase = await createClient();
  let q = supabase
    .from("announcements")
    .select("*")
    .eq("league_id", leagueId)
    .eq("is_published", true)
    .order("published_at", { ascending: false });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) console.error("getAnnouncements failed:", error.message);
  return data ?? [];
}

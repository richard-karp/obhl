import { createClient } from "@/utils/supabase/server";
import type { Json } from "@/lib/db/types";

/** League rules as Tiptap/ProseMirror JSON (or null if none set). */
export async function getRules(
  leagueId: string,
): Promise<{ content: Json | null; updated_at: string } | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("league_rules")
    .select("content, updated_at")
    .eq("league_id", leagueId)
    .maybeSingle();
  return data ?? null;
}

"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { requireManager } from "@/lib/auth/guards";

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Manager saves the league rules (Tiptap JSON).
 *
 * `leagueId` comes from the page's own resolved league. It used to pick the
 * oldest league in the table instead, which was invisible while there was only
 * one — and, once there were two, meant a manager editing the second league's
 * rules silently overwrote the first's. `league_rules` keeps no history, so
 * that was unrecoverable.
 */
export async function saveRules(leagueId: string, content: unknown) {
  const user = await requireManager();
  const supabase = await createClient();

  const { error } = await supabase.from("league_rules").upsert(
    {
      league_id: leagueId,
      content: content as any,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "league_id" },
  );
  revalidatePath("/[league]/rules", "page");
  revalidatePath("/[league]/manage/rules/edit", "page");
  return error ? { ok: false, message: error.message } : { ok: true };
}

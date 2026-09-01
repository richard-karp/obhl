"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { requireLeagueManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";

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
  const user = await requireLeagueManager(leagueId);
  const supabase = await createClient();

  // Read before write. `league_rules` keeps no history and this is an upsert,
  // so the row about to be replaced holds the only copy of the previous rules;
  // carrying it into the audit entry is what makes an overwrite recoverable.
  const { data: previous } = await supabase
    .from("league_rules")
    .select("content")
    .eq("league_id", leagueId)
    .maybeSingle();

  const { error } = await supabase.from("league_rules").upsert(
    {
      league_id: leagueId,
      content: content as any,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "league_id" },
  );

  // Only on a write that landed, and under the league's own id: `league_rules`
  // is one row per league and a first save has no row id yet. `leagueOfEntity`
  // in src/lib/audit.ts resolves "league_rules" the same way — without that
  // case the entry would be written with a null league and never appear.
  //
  // Awaited, like `remove_schedule` and unlike most of the app's audit calls,
  // for the same reason: a `void` promise can be left unfinished when the
  // runtime freezes the function after the response, and this entry holds the
  // only copy of the rules being replaced. logAudit swallows its own errors
  // (src/lib/audit.ts), so awaiting cannot turn a successful save into a
  // reported failure — it costs one insert's latency.
  if (!error) {
    await logAudit({
      user_id: user.id,
      action: "save_rules",
      entity_type: "league_rules",
      entity_id: leagueId,
      old_data: { content: previous?.content ?? null },
      new_data: { content: content as any },
    });
  }

  revalidatePath("/[league]/rules", "page");
  revalidatePath("/[league]/manage/rules/edit", "page");
  return error ? { ok: false, message: error.message } : { ok: true };
}

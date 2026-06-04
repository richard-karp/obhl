"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { requireManager } from "@/lib/auth/guards";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Manager saves the league rules (Tiptap JSON). */
export async function saveRules(content: unknown) {
  const user = await requireManager();
  const supabase = await createClient();
  const { data: league } = await supabase
    .from("leagues")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (!league) return { ok: false, message: "No league found." };

  const { error } = await supabase.from("league_rules").upsert(
    {
      league_id: league.id,
      content: content as any,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "league_id" },
  );
  revalidatePath("/rules");
  revalidatePath("/rules/edit");
  return error ? { ok: false, message: error.message } : { ok: true };
}

"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { requireLeagueManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Not exported: every export of a "use server" file is an endpoint. Keys are sorted because
// `jsonb` reorders them, so a plain `JSON.stringify` makes every save look like a change.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : val,
  );
}

/** `leagueId` is the page's resolved league: `league_rules` keeps no history to undo a wrong one. */
export async function saveRules(leagueId: string, content: unknown) {
  const user = await requireLeagueManager(leagueId);
  const supabase = await createClient();

  // Read before the upsert: `league_rules` keeps no history, so the awaited audit entry below
  // holds the only copy of the previous rules.
  const { data: previous } = await supabase
    .from("league_rules")
    .select("content")
    .eq("league_id", leagueId)
    .maybeSingle();

  const { data: saved, error } = await supabase
    .from("league_rules")
    .upsert(
      {
        league_id: leagueId,
        content: content as any,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "league_id" },
    )
    .select("id")
    .maybeSingle();

  // `saved`, not `!error`: a policy-refused write need not set `error` (`RUNBOOK.md` → Access
  // control → Traps). Only a real change is audited, keyed on the league (`leagueOfEntity`).
  if (
    saved &&
    canonical(previous?.content ?? null) !== canonical(content ?? null)
  ) {
    await logAudit({
      user_id: user.id,
      action: "save_rules",
      entity_type: "league_rules",
      entity_id: leagueId,
      old_data: { content: previous?.content ?? null },
      new_data: { content: content as any },
    });
  }

  // One path, because there is now one page: `/rules` serves the public the
  // rules and their manager the same page with an editor on it.
  revalidatePath("/[league]/rules", "page");

  // `saved`, not `error`, for the same reason: a silently refused save must not answer "Saved.".
  if (!saved) {
    return {
      ok: false,
      message:
        error?.message ?? "Rules were not saved. You may not have access.",
    };
  }
  return { ok: true };
}

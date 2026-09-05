"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { requireLeagueManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Stable JSON for comparing two Tiptap documents.
 *
 * Not exported on purpose: every export of a `"use server"` file is a callable
 * endpoint, and this is a helper.
 *
 * A plain `JSON.stringify` comparison does not work here. `previous.content`
 * comes back from a `jsonb` column, which normalises object key order, while
 * the incoming document carries the editor's order — so identical documents
 * serialise differently and every save would look like a change. Sorting keys
 * makes the comparison meaningful; arrays are left alone, since their order is
 * the document's structure.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : val,
  );
}

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

  // Two conditions, both deliberate.
  //
  // `saved` rather than `!error`: a write refused at the policy level in this
  // area need not set `error` (see the traps in ACCESS_CONTROL_HANDOFF.md), and
  // an audit entry for a save that did not happen is worse than none.
  // `requireLeagueManager` above should make that unreachable — this stops the
  // entry's truthfulness resting on that guard alone.
  //
  // And only when the document actually changed: re-saving an untouched page is
  // not an auditable event, and these entries carry two whole documents.
  //
  // The entry is keyed on the league id, not the `league_rules` row id — the
  // table is one row per league and a first save has no row id to name.
  // `leagueOfEntity` in src/lib/audit.ts resolves "league_rules" the same way;
  // without that case the entry would be written with a null league and never
  // appear. It is awaited, like `remove_schedule` and unlike most of the app's
  // audit calls, for the same reason: a `void` promise can be left unfinished
  // when the runtime freezes the function after the response, and this entry
  // holds the only copy of the rules being replaced. logAudit swallows its own
  // errors, so awaiting cannot turn a successful save into a reported failure.
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

  // Keyed on `saved`, not on `error`, for the reason stated eight lines above:
  // A WRITE REFUSED AT THE POLICY LEVEL IN THIS AREA NEED NOT SET `error`. The
  // audit gate already knew that; this return did not, so a silently refused
  // save answered `{ ok: true }` and the editor said "Saved." while nothing had
  // been written. `requireLeagueManager` at the top should make that
  // unreachable — this is what stops the manager's confirmation resting on that
  // guard alone.
  if (!saved) {
    return {
      ok: false,
      message:
        error?.message ?? "Rules were not saved. You may not have access.",
    };
  }
  return { ok: true };
}

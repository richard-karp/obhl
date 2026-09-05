"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import { finalizeGameById, reopenGameById } from "@/lib/games/finalize";

type RevertResult = { error: string } | { ok: true } | null;

export async function revertAuditEntries(
  _prev: RevertResult,
  formData: FormData,
): Promise<RevertResult> {
  const admin = createAdminClient();

  const auditIds = formData.getAll("auditId").map(String).filter(Boolean);
  if (auditIds.length === 0) return { error: "No actions selected." };

  const leagueId = String(formData.get("league_id") ?? "");
  if (!leagueId) return { error: "No league selected." };
  const manager = await requireLeagueManager(leagueId);

  // Reverting is a write — it reopens games, restores player status, undoes
  // captaincy. Scoped to the league the form was submitted from, so an id
  // belonging to another league cannot be reverted from this one.
  const { data: entries } = await admin
    .from("audit_log")
    .select(
      "id, action, entity_type, entity_id, new_data, old_data, created_at",
    )
    .in("id", auditIds)
    .eq("league_id", leagueId)
    .order("created_at", { ascending: false });

  if ((entries?.length ?? 0) !== auditIds.length) {
    return {
      error: "Some of those actions are no longer available in this league.",
    };
  }

  const errors: string[] = [];

  for (const entry of entries ?? []) {
    try {
      const nd = entry.new_data as Record<string, unknown> | null;
      const od = entry.old_data as Record<string, unknown> | null;

      switch (entry.action) {
        case "finalize_game":
          await reopenGameById(entry.entity_id, manager.id);
          break;

        case "reopen_game":
          await finalizeGameById(entry.entity_id, manager.id);
          break;

        case "generate_recap": {
          const { error } = await admin
            .from("games")
            .update({ ai_recap: null })
            .eq("id", entry.entity_id);
          if (error) throw new Error(`Clear recap failed: ${error.message}`);
          void logAudit({
            user_id: manager.id,
            action: "revert_generate_recap",
            entity_type: "game",
            entity_id: entry.entity_id,
          });
          revalidatePath("/[league]", "page");
          break;
        }

        case "add_player": {
          // Read from the row rather than the entry. `new_data` may be missing
          // `team_id` on older entries, and that gap used to skip the
          // played-since check entirely and hard-delete a row with games behind
          // it — the exact destruction 0036 exists to prevent.
          const { data: row } = await admin
            .from("team_players")
            .select("player_id, team_id, season_id")
            .eq("id", entry.entity_id)
            .maybeSingle();
          // Already gone: the add has nothing left to undo. Checked before the
          // columns are read, so there is no absent-id fallback to get wrong —
          // all three are NOT NULL on a row that exists.
          if (!row) break;
          const {
            player_id: playerId,
            team_id: teamId,
            season_id: seasonId,
          } = row;

          // Scoped to this season through `games`, which is where `season_id`
          // lives — player and team alone count every season this team has
          // played.
          const { count } = await admin
            .from("game_rosters")
            .select("*, games!inner(season_id)", { count: "exact", head: true })
            .eq("player_id", playerId)
            .eq("team_id", teamId)
            .eq("games.season_id", seasonId);

          if ((count ?? 0) > 0) {
            // They have dressed since the add, so the row is now the record of
            // those games — `v_goalie_stats` inner-joins it and `v_skater_stats`
            // left-joins it for jersey and position. Retire it instead of
            // deleting it, the same way removeRosterPlayer does. This used to
            // throw and refuse the whole revert; a departure undoes the add as
            // far as it can be undone without losing what happened.
            const { error } = await admin
              .from("team_players")
              .update({
                left_on: new Date().toISOString().slice(0, 10),
                is_captain: false,
                is_default_goalie: false,
              })
              .eq("id", entry.entity_id);
            if (error)
              throw new Error(`Mark player departed failed: ${error.message}`);
          } else {
            const { error } = await admin
              .from("team_players")
              .delete()
              .eq("id", entry.entity_id);
            if (error)
              throw new Error(`Remove player failed: ${error.message}`);
          }
          void logAudit({
            user_id: manager.id,
            action: "revert_add_player",
            entity_type: "team_player",
            entity_id: entry.entity_id,
            // The row may have just been deleted, so this entry cannot resolve
            // its own league. It is already known: every entry here was read
            // with `.eq("league_id", leagueId)` above.
            league_id: leagueId,
            new_data: { removal: (count ?? 0) > 0 ? "departed" : "deleted" },
          });
          break;
        }

        case "remove_player": {
          if (!od?.player_id) {
            throw new Error(
              "Missing player data — cannot restore (entry predates revert support).",
            );
          }
          // `removeRosterPlayer` now takes one of two branches: it deletes a row
          // with no games behind it, or marks one that has games departed. The
          // row's survival is what says which happened — and reading it rather
          // than the entry's `new_data.removal` is what makes this work for the
          // entries written before that field existed.
          const { data: survived } = await admin
            .from("team_players")
            .select("id")
            .eq("id", entry.entity_id)
            .maybeSingle();

          // `left_on` restored from the snapshot, never defaulted. The row may
          // have already been departed when it was removed, and defaulting
          // would silently put a player who left in February back on the active
          // roster — or, on the insert path, leave a restored player marked
          // departed. Either way nothing reports it.
          const leftOn = typeof od.left_on === "string" ? od.left_on : null;

          if (survived) {
            const { error } = await admin
              .from("team_players")
              .update({
                left_on: leftOn,
                is_captain: Boolean(od.is_captain),
                is_default_goalie: Boolean(od.is_default_goalie),
              })
              .eq("id", entry.entity_id);
            if (error)
              throw new Error(`Restore player failed: ${error.message}`);
          } else {
            const { error } = await admin.from("team_players").insert({
              id: entry.entity_id,
              player_id: String(od.player_id),
              team_id: String(od.team_id),
              season_id: String(od.season_id),
              position: (od.position as "F" | "D" | "G") ?? "F",
              jersey_number:
                typeof od.jersey_number === "number" ? od.jersey_number : null,
              is_captain: Boolean(od.is_captain),
              is_rookie: Boolean(od.is_rookie),
              injury_notes:
                typeof od.injury_notes === "string"
                  ? od.injury_notes || null
                  : null,
              is_suspended: Boolean(od.is_suspended),
              left_on: leftOn,
            });
            if (error)
              throw new Error(`Restore player failed: ${error.message}`);
          }
          void logAudit({
            user_id: manager.id,
            action: "revert_remove_player",
            entity_type: "team_player",
            entity_id: entry.entity_id,
          });
          break;
        }

        case "toggle_captain": {
          const prevValue = !Boolean(nd?.is_captain);
          const { error } = await admin
            .from("team_players")
            .update({ is_captain: prevValue })
            .eq("id", entry.entity_id);
          if (error)
            throw new Error(`Restore captain status failed: ${error.message}`);
          void logAudit({
            user_id: manager.id,
            action: "revert_toggle_captain",
            entity_type: "team_player",
            entity_id: entry.entity_id,
            new_data: { is_captain: prevValue },
          });
          break;
        }

        case "update_player_status": {
          const field = typeof nd?.field === "string" ? nd.field : null;
          if (!field) throw new Error("Missing field info.");
          if (od === null || Object.keys(od).length === 0) {
            throw new Error(
              "Missing old value — cannot restore (entry predates revert support).",
            );
          }
          if (field === "injury_notes") {
            const val =
              typeof od[field] === "string"
                ? (od[field] as string) || null
                : null;
            const { error } = await admin
              .from("team_players")
              .update({ injury_notes: val })
              .eq("id", entry.entity_id);
            if (error)
              throw new Error(`Restore status failed: ${error.message}`);
          } else if (field === "is_rookie") {
            const { error } = await admin
              .from("team_players")
              .update({ is_rookie: Boolean(od[field]) })
              .eq("id", entry.entity_id);
            if (error)
              throw new Error(`Restore status failed: ${error.message}`);
          } else if (field === "is_suspended") {
            const { error } = await admin
              .from("team_players")
              .update({ is_suspended: Boolean(od[field]) })
              .eq("id", entry.entity_id);
            if (error)
              throw new Error(`Restore status failed: ${error.message}`);
          }
          void logAudit({
            user_id: manager.id,
            action: "revert_update_player_status",
            entity_type: "team_player",
            entity_id: entry.entity_id,
            new_data: { field, value: od[field] },
          });
          break;
        }

        default:
          // Revert entries and unknown actions are skipped silently
          break;
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  revalidatePath("/[league]/audit", "page");
  revalidatePath("/[league]", "page");

  if (errors.length) return { error: errors.join("; ") };
  return { ok: true };
}

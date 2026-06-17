"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import { finalizeGameById, reopenGameById } from "@/lib/actions/games";

type RevertResult = { error: string } | { ok: true } | null;

export async function revertAuditEntries(
  _prev: RevertResult,
  formData: FormData,
): Promise<RevertResult> {
  const manager = await requireManager();
  const admin = createAdminClient();

  const auditIds = formData.getAll("auditId").map(String).filter(Boolean);
  if (auditIds.length === 0) return { error: "No actions selected." };

  const { data: entries } = await admin
    .from("audit_log")
    .select("id, action, entity_type, entity_id, new_data, old_data, created_at")
    .in("id", auditIds)
    .order("created_at", { ascending: false });

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
          revalidatePath("/");
          break;
        }

        case "add_player": {
          const playerId = typeof nd?.player_id === "string" ? nd.player_id : null;
          const teamId = typeof nd?.team_id === "string" ? nd.team_id : null;
          if (!playerId) {
            throw new Error("Cannot revert add_player: entry missing player_id (predates revert support).");
          }
          if (teamId) {
            const { data: gameRows } = await admin
              .from("game_rosters")
              .select("id")
              .eq("player_id", playerId)
              .eq("team_id", teamId)
              .limit(1);
            if (gameRows && gameRows.length > 0) {
              throw new Error("Cannot remove player who has game history on this team.");
            }
          }
          const { error } = await admin
            .from("team_players")
            .delete()
            .eq("id", entry.entity_id);
          if (error) throw new Error(`Remove player failed: ${error.message}`);
          void logAudit({
            user_id: manager.id,
            action: "revert_add_player",
            entity_type: "team_player",
            entity_id: entry.entity_id,
          });
          break;
        }

        case "remove_player": {
          if (!od?.player_id) {
            throw new Error("Missing player data — cannot restore (entry predates revert support).");
          }
          const { error } = await admin.from("team_players").insert({
            id: entry.entity_id,
            player_id: String(od.player_id),
            team_id: String(od.team_id),
            season_id: String(od.season_id),
            position: (od.position as "F" | "D" | "G") ?? "F",
            jersey_number: typeof od.jersey_number === "number" ? od.jersey_number : null,
            is_captain: Boolean(od.is_captain),
            is_rookie: Boolean(od.is_rookie),
            injury_notes: typeof od.injury_notes === "string" ? od.injury_notes || null : null,
            is_suspended: Boolean(od.is_suspended),
          });
          if (error) throw new Error(`Restore player failed: ${error.message}`);
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
          if (error) throw new Error(`Restore captain status failed: ${error.message}`);
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
            throw new Error("Missing old value — cannot restore (entry predates revert support).");
          }
          if (field === "injury_notes") {
            const val = typeof od[field] === "string" ? (od[field] as string) || null : null;
            const { error } = await admin
              .from("team_players")
              .update({ injury_notes: val })
              .eq("id", entry.entity_id);
            if (error) throw new Error(`Restore status failed: ${error.message}`);
          } else if (field === "is_rookie") {
            const { error } = await admin
              .from("team_players")
              .update({ is_rookie: Boolean(od[field]) })
              .eq("id", entry.entity_id);
            if (error) throw new Error(`Restore status failed: ${error.message}`);
          } else if (field === "is_suspended") {
            const { error } = await admin
              .from("team_players")
              .update({ is_suspended: Boolean(od[field]) })
              .eq("id", entry.entity_id);
            if (error) throw new Error(`Restore status failed: ${error.message}`);
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

  revalidatePath("/audit");
  revalidatePath("/");

  if (errors.length) return { error: errors.join("; ") };
  return { ok: true };
}

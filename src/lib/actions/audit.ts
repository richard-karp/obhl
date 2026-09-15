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

  // Reverting is a write, so it is scoped to the submitting league: another league's
  // entry cannot be reverted from this one.
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

        case "add_player": {
          // Read from the row, not the entry: older entries lack `team_id`, which skips the
          // played-since check and hard-deletes a row with games behind it (0036).
          const { data: row } = await admin
            .from("team_players")
            .select("player_id, team_id, season_id")
            .eq("id", entry.entity_id)
            .maybeSingle();
          // Already gone: the add has nothing left to undo.
          if (!row) break;
          const {
            player_id: playerId,
            team_id: teamId,
            season_id: seasonId,
          } = row;

          // Scoped to this season through `games`: player and team alone count every
          // season this team has played.
          const { count } = await admin
            .from("game_rosters")
            .select("*, games!inner(season_id)", { count: "exact", head: true })
            .eq("player_id", playerId)
            .eq("team_id", teamId)
            .eq("games.season_id", seasonId);

          if ((count ?? 0) > 0) {
            // Dressed since the add, so the row is the record of those games (`v_goalie_stats`
            // inner-joins it): retire it as `removeRosterPlayer` does, never delete it.
            const { error } = await admin
              .from("team_players")
              .update({
                left_on: new Date().toISOString().slice(0, 10),
                is_captain: false,
                // Both are claims about the present that a departure ends, as in `movePlayerToTeam`.
                night_of_week: null,
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
            // Passed: the row may be gone, and a null-league entry is hidden (`RUNBOOK.md` →
            // Access control → Traps). Every entry here was read under `leagueId`.
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
          // The row's survival says whether `removeRosterPlayer` deleted or departed it; read
          // it, not `new_data.removal`, which older entries lack.
          const { data: survived } = await admin
            .from("team_players")
            .select("id")
            .eq("id", entry.entity_id)
            .maybeSingle();

          // `left_on` comes from the snapshot, never a default: a default silently puts a
          // departed player back on the active roster, or marks a restored one departed.
          const leftOn = typeof od.left_on === "string" ? od.left_on : null;

          if (survived) {
            const { error } = await admin
              .from("team_players")
              .update({
                left_on: leftOn,
                is_captain: Boolean(od.is_captain),
                // ⚠️ From the snapshot. Entries before 0049 carry `is_default_goalie` instead,
                // which has no honest night equivalent, so they restore null.
                night_of_week:
                  typeof od.night_of_week === "number"
                    ? od.night_of_week
                    : null,
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
              // ⚠️ Restored on this branch too: dropping it brings a removed goalie back
              // without the night that made them a starter.
              night_of_week:
                typeof od.night_of_week === "number" ? od.night_of_week : null,
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

import { cookies } from "next/headers";
import { requireManager } from "@/lib/auth/guards";
import { createAdminClient } from "@/utils/supabase/admin";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { AuditSessionList, type AuditSession } from "@/components/manage/audit-session-list";
import { revertAuditEntries } from "@/lib/actions/audit";

export default async function AuditLogPage() {
  await requireManager();
  const admin = createAdminClient();
  const cookieStore = await cookies();
  const currentSessionId = cookieStore.get("audit_session")?.value ?? null;

  const { data: rows } = await admin
    .from("audit_log")
    .select("id, created_at, user_id, action, entity_type, entity_id, new_data, old_data, session_id")
    .order("created_at", { ascending: false })
    .limit(500);

  if (!rows || rows.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Audit Log" description="Recent staff actions" />
        <EmptyState title="No actions logged yet" />
      </div>
    );
  }

  // --- Resolve user display names ---
  const userIds = [
    ...new Set(rows.map((r) => r.user_id).filter((id): id is string => id != null)),
  ];
  let nameMap = new Map<string, string>();
  if (userIds.length) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, display_name")
      .in("id", userIds);
    nameMap = new Map(
      (profiles ?? []).map((p) => [p.id, p.display_name ?? p.id.slice(0, 8)]),
    );
  }

  // --- Resolve player names for team_player entries ---

  // Step 1: for toggle_captain / update_player_status, entity_id is a team_player row —
  // look up the player_id from team_players (rows still exist; we're only updating).
  const lookupByTeamPlayer = [
    ...new Set(
      rows
        .filter(
          (r) =>
            r.entity_type === "team_player" &&
            (r.action === "toggle_captain" ||
              r.action === "update_player_status" ||
              r.action === "revert_toggle_captain" ||
              r.action === "revert_update_player_status"),
        )
        .map((r) => r.entity_id),
    ),
  ];

  const tpToPlayerMap = new Map<string, string>(); // team_player_id → player_id
  if (lookupByTeamPlayer.length) {
    const { data: tps } = await admin
      .from("team_players")
      .select("id, player_id")
      .in("id", lookupByTeamPlayer);
    for (const tp of tps ?? []) tpToPlayerMap.set(tp.id, tp.player_id);
  }

  // Step 2: collect player_ids embedded in new_data/old_data (add_player, remove_player)
  const directPlayerIds: string[] = [];
  for (const r of rows) {
    const nd = r.new_data as Record<string, unknown> | null;
    const od = r.old_data as Record<string, unknown> | null;
    if (typeof nd?.player_id === "string") directPlayerIds.push(nd.player_id);
    if (typeof od?.player_id === "string") directPlayerIds.push(od.player_id);
  }

  // Step 3: batch query players
  const allPlayerIds = [
    ...new Set([...directPlayerIds, ...tpToPlayerMap.values()]),
  ];
  let playerNameMap = new Map<string, string>();
  if (allPlayerIds.length) {
    const { data: players } = await admin
      .from("players")
      .select("id, first_name, last_name")
      .in("id", allPlayerIds);
    playerNameMap = new Map(
      (players ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`]),
    );
  }

  // Combined: team_player_id → display name
  const tpNameMap = new Map<string, string>();
  for (const [tpId, playerId] of tpToPlayerMap) {
    const name = playerNameMap.get(playerId);
    if (name) tpNameMap.set(tpId, name);
  }

  type AuditRow = NonNullable<typeof rows>[0];

  // --- Compute display label per entry ---
  function entryLabel(r: AuditRow): string {
    const nd = r.new_data as Record<string, unknown> | null;
    const od = r.old_data as Record<string, unknown> | null;
    switch (r.action) {
      case "finalize_game":
        return "Finalized game";
      case "reopen_game":
        return "Reopened game";
      case "generate_recap":
        return "Generated AI recap";
      case "add_player": {
        const pid = typeof nd?.player_id === "string" ? nd.player_id : null;
        const name = pid ? playerNameMap.get(pid) : undefined;
        return `Added ${name ?? "player"} to roster`;
      }
      case "remove_player": {
        const pid = typeof od?.player_id === "string" ? od.player_id : null;
        const name = pid ? playerNameMap.get(pid) : undefined;
        return `Removed ${name ?? "player"} from roster`;
      }
      case "toggle_captain": {
        const name = tpNameMap.get(r.entity_id);
        return Boolean(nd?.is_captain)
          ? `Made ${name ?? "player"} captain`
          : `Removed captain from ${name ?? "player"}`;
      }
      case "update_player_status": {
        const name = tpNameMap.get(r.entity_id);
        const field = typeof nd?.field === "string" ? nd.field.replace(/_/g, " ") : "status";
        return `Updated ${field} for ${name ?? "player"}`;
      }
      default:
        if (r.action.startsWith("revert_")) {
          return `Reverted: ${r.action.replace(/^revert_/, "").replace(/_/g, " ")}`;
        }
        return r.action.replace(/_/g, " ");
    }
  }

  // --- Determine if an entry can be reverted ---
  function isRevertible(r: AuditRow): boolean {
    const nd = r.new_data as Record<string, unknown> | null;
    const od = r.old_data as Record<string, unknown> | null;
    switch (r.action) {
      case "finalize_game":
      case "reopen_game":
      case "generate_recap":
        return true;
      case "add_player":
        return typeof nd?.player_id === "string";
      case "remove_player":
        return typeof od?.player_id === "string";
      case "toggle_captain":
        return nd?.is_captain !== undefined;
      case "update_player_status":
        return od !== null && Object.keys(od).length > 0;
      default:
        return false;
    }
  }

  // --- Group entries by session_id ---
  const sessionMap = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.session_id ?? "__none__";
    const group = sessionMap.get(key) ?? [];
    group.push(row);
    sessionMap.set(key, group);
  }

  const sessions: AuditSession[] = [...sessionMap.entries()].map(
    ([key, entries]) => ({
      session_id: key === "__none__" ? null : key,
      user_name: entries[0]?.user_id
        ? (nameMap.get(entries[0].user_id) ?? entries[0].user_id.slice(0, 8))
        : "Unknown",
      entries: entries.map((e) => ({
        id: e.id,
        created_at: e.created_at,
        action: e.action,
        entity_id: e.entity_id,
        label: entryLabel(e),
        isRevertible: isRevertible(e),
      })),
      isCurrentSession: currentSessionId !== null && key === currentSessionId,
    }),
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Audit Log" description="Recent staff actions" />
      <AuditSessionList sessions={sessions} revertAction={revertAuditEntries} />
    </div>
  );
}

import { cookies } from "next/headers";
import { requireLeagueManager } from "@/lib/auth/guards";
import { notFound } from "next/navigation";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { createAdminClient } from "@/utils/supabase/admin";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { AuditSessionList, type AuditSession } from "@/components/manage/audit-session-list";
import { revertAuditEntries } from "@/lib/actions/audit";
import { OfficeAuditNotice } from "@/components/manage/office-audit-notice";
import { recentOfficeAudit } from "@/lib/audit";

export default async function AuditLogPage({
  params,
}: {
  params: Promise<{ league: string }>;
}) {
  const { league: leagueSlug } = await params;
  const league = await resolveLeagueBySlug(leagueSlug);
  if (!league) notFound();
  await requireLeagueManager(league.id);
  const admin = createAdminClient();
  const cookieStore = await cookies();
  const currentSessionId = cookieStore.get("audit_session")?.value ?? null;

  // League Office changes, as a band rather than rows in this log. They carry no
  // league — one act reaches all of them — so the query below cannot see them
  // and should not: a manager would get N rows about people who never worked
  // here, none of which they can act on.
  const officeLog = await recentOfficeAudit(5);

  const { data: rows } = await admin
    .from("audit_log")
    .select("id, created_at, user_id, action, entity_type, entity_id, new_data, old_data, session_id")
    // Entries written before audit_log had a league have none, and stay out.
    .eq("league_id", league.id)
    .order("created_at", { ascending: false })
    .limit(500);

  const officeBand = (
    <OfficeAuditNotice entries={officeLog} heading="League Office changes" />
  );

  if (!rows || rows.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Audit Log" description="Recent staff actions" />
        {officeBand}
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
    // No `left_on` filter: the log is history, and this only turns a row id
    // recorded in an old entry into a name. A departed row is precisely the
    // kind the log is most likely to be asking about.
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
      case "save_rules":
        return "Updated league rules";
      // Season, announcement, logo and import entries name their subject from
      // their own payload for the same reason the staff ones do: the entity id
      // is a season or a league, not the thing that changed, and for the
      // destructive ones the row it would name is gone.
      case "create_season":
        return `Created season ${typeof nd?.name === "string" ? nd.name : ""}`.trim();
      case "set_active_season": {
        const to = typeof nd?.name === "string" ? nd.name : "a season";
        const from = typeof od?.name === "string" ? od.name : null;
        return from ? `Made ${to} the active season (was ${from})` : `Made ${to} the active season`;
      }
      case "create_team":
        return `Added team ${typeof nd?.name === "string" ? nd.name : ""}`.trim();
      case "unenroll_team":
        return `Removed ${typeof od?.name === "string" ? od.name : "a team"} from this season`;
      case "carry_forward_enrollment": {
        // `teams` counts what was actually added, so zero has two meanings and
        // `from_season_id` is what separates them.
        const n = typeof nd?.teams === "number" ? nd.teams : 0;
        if (n) return `Carried ${n} team${n === 1 ? "" : "s"} forward from the previous season`;
        return nd?.from_season_id
          ? "Carried enrollment forward; every team was already enrolled"
          : "Carried enrollment forward, but no earlier season had teams";
      }
      case "generate_summary":
        return "Generated AI league summary";
      case "create_announcement":
        return `Posted "${typeof nd?.title === "string" ? nd.title : "an announcement"}"`;
      case "delete_announcement":
        return `Deleted "${typeof od?.title === "string" ? od.title : "an announcement"}"`;
      case "upload_logo":
        return "Uploaded a team logo";
      case "import_league":
        return `Imported league ${typeof nd?.name === "string" ? nd.name : ""}`.trim();
      // Staff entries name the person from their own payload: entity_id is the
      // league, not the profile, so there is no id here to look a name up from.
      case "add_staff": {
        const who = typeof nd?.display_name === "string" ? nd.display_name : nd?.email;
        const r = typeof nd?.role === "string" ? nd.role.replace("league_", "") : "staff";
        return `Added ${typeof who === "string" ? who : "an account"} as ${r}`;
      }
      case "grant_league": {
        const who = typeof nd?.email === "string" ? nd.email : "a manager";
        return `Gave ${who} this league`;
      }
      case "update_staff_role": {
        const who = typeof nd?.display_name === "string" ? nd.display_name : "someone";
        const from = typeof od?.role === "string" ? od.role.replace("league_", "") : "?";
        const to = typeof nd?.role === "string" ? nd.role.replace("league_", "") : "?";
        return `Changed ${who} from ${from} to ${to}`;
      }
      case "remove_staff": {
        const who = typeof od?.display_name === "string" ? od.display_name : "someone";
        return `Removed ${who} from this league`;
      }
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
      // The four roster/player entries added with the editing tools. Each names
      // its subject from its OWN payload, like the staff entries above and for
      // the same reason: `update_player_name` and the archive pair carry a
      // PLAYER id, which the two lookups above (team_player ids, and player ids
      // read out of add/remove payloads) do not resolve.
      case "update_roster_player": {
        const who = typeof nd?.name === "string" ? nd.name : "a player";
        const num = nd?.jersey_number == null ? "no number" : `#${nd.jersey_number}`;
        return `Set ${who} to ${num}, ${nd?.position ?? "?"}`;
      }
      case "update_player_name": {
        const from = od ? `${od.first_name} ${od.last_name}` : "a player";
        const to = nd ? `${nd.first_name} ${nd.last_name}` : "a new name";
        return `Renamed ${from} to ${to} (in every league)`;
      }
      case "archive_player": {
        const who = typeof nd?.name === "string" ? nd.name : "a player";
        return `Archived ${who} from this league`;
      }
      case "restore_player": {
        const who = typeof nd?.name === "string" ? nd.name : "a player";
        return `Restored ${who} to this league`;
      }
      case "transfer_player": {
        // `new_data.name` is only written on the add-form path; `transferPlayer`
        // passes no label. The entity is a `team_players` id either way, which
        // `tpNameMap` resolves — the same fallback the other roster cases use.
        const who =
          (typeof nd?.name === "string" ? nd.name : null) ??
          tpNameMap.get(r.entity_id) ??
          null;
        const via = nd?.via === "add" ? " (via the add form)" : "";
        return `Transferred ${who ?? "a player"} to another team${via}`;
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
      {officeBand}
      <AuditSessionList
        sessions={sessions}
        leagueId={league.id}
        revertAction={revertAuditEntries}
      />
    </div>
  );
}

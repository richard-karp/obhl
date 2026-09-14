import { cookies } from "next/headers";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  leagueIdIfExists,
  leagueOfAnnouncement,
  leagueOfGame,
  leagueOfSeason,
  leagueOfScheduleConstraint,
  leagueOfTeam,
  leagueOfTeamPlayer,
} from "@/lib/league/of-entity";

type AuditEntry = {
  /** ⚠️ `null` when the system acted (the close-night cron): never attribute it to a person. */
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  old_data?: object | null;
  new_data?: object | null;
  /**
   * Pass it when logging a delete: once the row is gone `leagueOfEntity` returns null,
   * and a null league hides the entry from every view.
   */
  league_id?: string | null;
};

type Admin = ReturnType<typeof createAdminClient>;

/**
 * ⚠️ An unlisted `entity_type` files under a null league, hidden from every view: add its
 * case in the change that starts logging it (`RUNBOOK.md` → Access control → Traps).
 */
async function leagueOfEntity(
  admin: Admin,
  entityType: string,
  entityId: string,
): Promise<string | null> {
  switch (entityType) {
    case "team":
      return leagueOfTeam(entityId, admin);
    case "season":
      return leagueOfSeason(entityId, admin);
    case "game":
      return leagueOfGame(entityId, admin);
    case "team_player":
      return leagueOfTeamPlayer(entityId, admin);
    case "announcement":
      return leagueOfAnnouncement(entityId, admin);
    // A delete resolves to null here, so `deleteScheduleConstraint` passes `league_id` itself.
    case "schedule_constraint":
      return leagueOfScheduleConstraint(entityId, admin);
    // Null by decision: `players` has no `league_id`. Callers pass `league_id`, as `mergePlayers` does.
    case "player":
      return null;
    case "league_rules":
    case "league_staff":
    // An import files under the league it creates.
    case "league":
      return leagueIdIfExists(entityId, admin);
    // ⛔ Null by decision, not a missing case: the Office is instance-wide. Its entries are read
    // on the admin client (`recentOfficeAudit`), never in a league's log.
    case "office":
      return null;
    default:
      return null;
  }
}

export type OfficeAuditEntry = {
  id: string;
  created_at: string | null;
  action: string;
  actor: string;
  target: string;
};

/**
 * ⛔ Two feeds share `entity_type: "office"` and must not share a limit: a week of
 * self-serve password changes would push every appointment out of the band.
 */
const OVERSIGHT_ACTIONS = ["appoint_deputy", "remove_deputy", "set_password"];
const SELF_SERVE_ACTIONS = ["set_own_password"];

/**
 * Admin client: a null league is hidden by `managers read audit_log`. Names come from the
 * entry's snapshot first, the only record left once a profile is deleted.
 */
export async function recentOfficeAudit(
  limit = 5,
): Promise<OfficeAuditEntry[]> {
  return officeEntries(OVERSIGHT_ACTIONS, limit);
}

/** Read only on `/manage/office`: instance-wide account events no league manager acts on. */
export async function recentPasswordAudit(
  limit = 10,
): Promise<OfficeAuditEntry[]> {
  return officeEntries(SELF_SERVE_ACTIONS, limit);
}

async function officeEntries(
  actions: string[],
  limit: number,
): Promise<OfficeAuditEntry[]> {
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("audit_log")
    .select("id, created_at, user_id, action, entity_id, old_data, new_data")
    .eq("entity_type", "office")
    .in("action", actions)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (!rows?.length) return [];

  const ids = [
    ...new Set(
      rows
        .flatMap((r) => [r.user_id, r.entity_id])
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, display_name")
    .in("id", ids);
  const nameById = new Map(
    (profiles ?? []).map((p) => [p.id, p.display_name ?? null]),
  );

  const snapshotName = (blob: unknown): string | null => {
    if (!blob || typeof blob !== "object") return null;
    const name = (blob as { display_name?: unknown }).display_name;
    return typeof name === "string" && name.length > 0 ? name : null;
  };
  const short = (id: string | null) => (id ? id.slice(0, 8) : "Unknown");

  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    action: r.action,
    actor: nameById.get(r.user_id ?? "") ?? short(r.user_id),
    target:
      snapshotName(r.new_data) ??
      snapshotName(r.old_data) ??
      nameById.get(r.entity_id) ??
      short(r.entity_id),
  }));
}

export async function logAudit(entry: AuditEntry) {
  try {
    const store = await cookies();
    const session_id = store.get("audit_session")?.value ?? null;
    const admin = createAdminClient();
    await admin.from("audit_log").insert({
      session_id: session_id ?? undefined,
      league_id:
        entry.league_id ??
        (await leagueOfEntity(admin, entry.entity_type, entry.entity_id)),
      user_id: entry.user_id,
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      old_data: (entry.old_data ?? null) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new_data: (entry.new_data ?? null) as any,
    });
  } catch {
    // audit logging is non-critical; never surface errors to users
  }
}

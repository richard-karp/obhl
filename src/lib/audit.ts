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
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  old_data?: object | null;
  new_data?: object | null;
  /**
   * The league to file under, when the caller already knows it.
   *
   * For actions that DESTROY the entity they are logging: once the row is gone
   * `leagueOfEntity` has nothing to resolve from and returns null, and a null
   * league is hidden by RLS and filtered out of every league-scoped view — so
   * the entry is written correctly and never appears. Resolve the league before
   * the delete and pass it here.
   */
  league_id?: string | null;
};

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The league an audited entity belongs to, so the log can be read and reverted
 * per league.
 *
 * Resolved here rather than at each call site: every one of them already holds
 * the entity id, and none of them holds a league.
 *
 * ⚠️ An entity type that isn't listed logs with no league. The entry is still
 * written, but a null league is filtered out of every league-scoped view *and*
 * hidden by RLS (`manages_league(null)` is false) — so it is correct and
 * invisible. Safe for a best-effort log, and a silent no-op for anyone adding a
 * new `entity_type`: add the type here in the same change that starts logging
 * it.
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
    // Added in the SAME change as the first `logAudit({entity_type:
    // "schedule_constraint"})` call, per the warning above: an unhandled type
    // logs with a null league, and a null league is hidden by RLS and filtered
    // out of every league-scoped view — correct, written, and permanently
    // invisible. A DELETE resolves to null here once the row is gone, so
    // `deleteScheduleConstraint` reads the league before the delete and passes
    // it explicitly.
    case "schedule_constraint":
      return leagueOfScheduleConstraint(entityId, admin);
    // A player is global — `players` has no `league_id`, and the same human in
    // two leagues is two records — so there is no league to resolve from the id.
    // Listed anyway rather than left to `default`, so the null is a decision
    // someone made and not a type nobody added. Callers logging a player pass
    // `league_id` themselves; `mergePlayers` does.
    case "player":
      return null;
    case "league_rules":
    case "league_staff":
    // An import creates the league it is filed under, so the league's own id is
    // the only id the entry can name.
    case "league":
      return leagueIdIfExists(entityId, admin);
    // ⛔ NULL BY DECISION, NOT BY DEFAULT. The League Office is instance-wide: a
    // tier reaches every league, so there is no league to file an appointment
    // under, and picking one would be a lie.
    //
    // This case looks redundant — `default` already returns null, and even an
    // explicit `league_id: null` from the caller falls through to here, because
    // `logAudit` resolves `entry.league_id ?? leagueOfEntity(...)` and `??`
    // treats null as absent. That is exactly why it is written out. Reaching
    // null by decision and reaching it by falling off the end of a switch are
    // indistinguishable afterwards, and the warning above tells the next person
    // that an unlisted type is a MISTAKE. Without this line, "office" looks like
    // one of those mistakes forever.
    //
    // The consequence is intended and load-bearing: a null league is hidden by
    // RLS and filtered out of every league-scoped view, so these entries never
    // clutter a league's log. They are read on the admin client instead — see
    // `recentOfficeAudit`.
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
 * Recent League Office appointments and removals.
 *
 * Read on the admin client on purpose: these entries carry no league, and a null
 * league is hidden by `managers read audit_log` — so a session could never see
 * them, which is what keeps them out of the per-league log.
 *
 * Names come from the entry's own snapshot first and the live profile only as a
 * fallback. The snapshot is the point of an audit entry: after a profile is
 * deleted it is the only thing left that says who this was.
 */
export async function recentOfficeAudit(limit = 5): Promise<OfficeAuditEntry[]> {
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("audit_log")
    .select("id, created_at, user_id, action, entity_id, old_data, new_data")
    .eq("entity_type", "office")
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

import { cookies } from "next/headers";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  leagueIdIfExists,
  leagueOfAnnouncement,
  leagueOfGame,
  leagueOfSeason,
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
    default:
      return null;
  }
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

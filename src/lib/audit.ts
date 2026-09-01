import { cookies } from "next/headers";
import { createAdminClient } from "@/utils/supabase/admin";
import {
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
};

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The league an audited entity belongs to, so the log can be read and reverted
 * per league.
 *
 * Resolved here rather than at the sixteen call sites: every one of them
 * already holds the entity id, and none of them holds a league. An entity type
 * that isn't listed logs with no league — the entry is still written, it just
 * won't appear in a league-scoped view, which is the safe direction for a
 * best-effort log.
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
      league_id: await leagueOfEntity(admin, entry.entity_type, entry.entity_id),
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

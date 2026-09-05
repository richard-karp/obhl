"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import { addLeagueMembership } from "@/lib/auth/membership";
import { logAudit } from "@/lib/audit";
import { slugify } from "@/lib/utils/slug";
import { isReservedLeagueSlug } from "@/lib/league/reserved-slugs";
import {
  fetchEsportsdeskLeague,
  parseEsportsdeskUrl,
  type ParsedLeague,
} from "@/lib/import/esportsdesk";
import type { ImportRunState } from "./import";

// The same twelve team colours the full importer assigns. Copied rather than
// shared because `import.ts` is a "use server" module, where every export has
// to be an async function — a colour array cannot be exported from it. They are
// cosmetic defaults a manager can change per team, so the two lists drifting
// apart costs nothing.
const palette = [
  "#0ea5e9", "#b45309", "#16a34a", "#64748b", "#7c3aed", "#dc2626",
  "#0891b2", "#ca8a04", "#475569", "#059669", "#db2777", "#4f46e5",
];

/**
 * Import ONLY teams and players from an esportsdesk season, as the starting
 * draft for a new OBHL season. Deliberately a sibling of runEsportsdeskImport
 * rather than a flag on it: that one is a faithful one-time migration and this
 * one throws away everything but the rosters, so "success" means two different
 * things. It never calls fetchEsportsdeskSchedule or fetchEsportsdeskStats.
 */
export async function runRosterOnlyImport(
  _prev: ImportRunState,
  formData: FormData,
): Promise<ImportRunState> {
  // Role only, and deliberately: this creates a league that does not exist yet,
  // so there is no membership to check it against. Registered in
  // league-guards.test.ts for exactly this reason.
  const manager = await requireManager();
  const url = String(formData.get("url") ?? "");
  const leagueName = String(formData.get("league_name") ?? "").trim();
  const seasonName =
    String(formData.get("season_name") ?? "").trim() || "Imported Season";
  // esportsdesk childSeasonID to import (empty = the league's current season).
  const sourceSeason = String(formData.get("season") ?? "").trim() || null;
  const ids = parseEsportsdeskUrl(url);
  if (!ids || !leagueName) {
    return { ok: false, message: "Missing the source URL or a league name." };
  }

  // The slug is the league's address, so a name that cannot produce a usable
  // one is rejected before the import does any work. Both cases would otherwise
  // create a league nobody can open, and there is no UI to delete one.
  const leagueSlug = slugify(leagueName);
  if (!leagueSlug) {
    return {
      ok: false,
      message: `"${leagueName}" has no letters or numbers to build a URL from — the league would have no address. Pick a different name.`,
    };
  }
  if (isReservedLeagueSlug(leagueSlug)) {
    return {
      ok: false,
      message: `"${leagueName}" makes the slug "${leagueSlug}", which is reserved — the league would be unreachable at /${leagueSlug}. Pick a different name.`,
    };
  }

  const admin = createAdminClient();
  let parsed: ParsedLeague;
  try {
    parsed = await fetchEsportsdeskLeague(ids.clientId, ids.leagueId, sourceSeason);
  } catch (e) {
    return { ok: false, message: `Fetch failed: ${(e as Error).message}` };
  }
  // Checked before the first write, while backing out is still free. A source
  // season that parses to nothing — usually a childSeasonID that does not match
  // the league — would otherwise leave a permanent, public, empty league behind,
  // and there is no UI to delete one.
  if (parsed.teams.length === 0) {
    return { ok: false, message: "No teams found at that URL." };
  }

  const { data: league, error: lErr } = await admin
    .from("leagues")
    .insert({ name: leagueName, slug: leagueSlug, is_public: true })
    .select("id")
    .single();
  if (lErr || !league) {
    return {
      ok: false,
      message:
        lErr?.code === "23505"
          ? `A league named "${leagueName}" already exists — pick a different name.`
          : (lErr?.message ?? "Couldn't create the league."),
    };
  }

  // Before anything else is written: an imported league whose creator is not a
  // member is a league nobody can open, and there is no UI to delete one.
  await addLeagueMembership(manager.id, league.id);

  // Filed while the league still exists, so its id resolves. The one exit below
  // that FAILS deletes the league again (the season insert), and this entry goes
  // with it: `audit_log.league_id` is `references leagues(id) on delete cascade`
  // (0031). A rolled-back import leaves no entry, which is right — nothing was
  // created. `mode` is what separates this from a full migration in the log.
  await logAudit({
    user_id: manager.id,
    action: "import_league",
    entity_type: "league",
    entity_id: league.id,
    new_data: {
      name: leagueName,
      slug: leagueSlug,
      source: url,
      mode: "rosters_only",
    },
  });

  const { data: season, error: sErr } = await admin
    .from("seasons")
    .insert({ league_id: league.id, name: seasonName, is_active: false })
    .select("id")
    .single();
  if (sErr || !season) {
    await admin.from("leagues").delete().eq("id", league.id);
    return { ok: false, message: `Couldn't create the season: ${sErr?.message}` };
  }

  let teamCount = 0;
  let playerCount = 0;
  let ci = 0;
  // Teams that did not import cleanly, named in the returned message. A roster
  // draft is the only thing this action produces, so a partial one has to say
  // so: counting a team whose roster insert failed would report a draft the
  // manager does not have. Each counter below is incremented only after the
  // write it describes has succeeded.
  const problems: string[] = [];

  for (const t of parsed.teams) {
    const { data: team, error: tErr } = await admin
      .from("teams")
      .insert({
        league_id: league.id,
        name: t.name,
        slug: slugify(t.name),
        color: palette[ci++ % palette.length],
      })
      .select("id")
      .single();
    if (tErr || !team) {
      problems.push(`${t.name} (team: ${tErr?.message ?? "not created"})`);
      continue;
    }
    // Counted only once it is in the season: a team that exists but was never
    // joined to one is absent from every season-scoped view, so reporting it as
    // imported would be a lie the manager cannot see.
    const { error: stErr } = await admin
      .from("season_teams")
      .insert({ season_id: season.id, team_id: team.id });
    if (stErr) {
      problems.push(`${t.name} (not added to the season: ${stErr.message})`);
      continue;
    }
    teamCount++;
    if (t.players.length === 0) continue;

    // Bulk-insert this team's players, then their roster rows — two calls per
    // team instead of two per player (a real import is hundreds of players).
    // PostgREST returns inserted rows in input order, so indexes line up.
    const { data: inserted, error: pErr } = await admin
      .from("players")
      .insert(
        t.players.map((p) => ({ first_name: p.firstName, last_name: p.lastName })),
      )
      .select("id");
    if (pErr || !inserted || inserted.length !== t.players.length) {
      problems.push(`${t.name} (players: ${pErr?.message ?? "incomplete insert"})`);
      continue;
    }

    // A jersey is unique per team, so only the first wearer keeps the number and
    // later repeats get null (the bulk insert can't lean on a per-row retry).
    // Postgres does not collide nulls in a unique index, so any number of
    // unnumbered players is fine.
    const usedJerseys = new Set<number>();
    const rosterRows = t.players.map((p, i) => {
      let jersey = p.number;
      if (jersey != null) {
        if (usedJerseys.has(jersey)) jersey = null;
        else usedJerseys.add(jersey);
      }
      return {
        season_id: season.id,
        team_id: team.id,
        player_id: inserted[i].id,
        jersey_number: jersey,
        position: p.position,
        is_captain: p.isCaptain,
      };
    });
    const { error: rErr } = await admin.from("team_players").insert(rosterRows);
    if (rErr) {
      // The `players` rows above are already committed and now belong to no
      // roster. Left in place deliberately: deleting on a failure path is how
      // this codebase loses data, and the duplicate-merge tool can absorb them.
      // What matters is that they are not counted as an imported roster.
      problems.push(`${t.name} (roster: ${rErr.message})`);
      continue;
    }
    playerCount += t.players.length;
  }

  revalidatePath("/[league]/seasons", "page");
  revalidatePath("/[league]", "layout");
  // This import creates a league; the root landing page lists them.
  revalidatePath("/");
  const shortfall =
    problems.length > 0
      ? ` ${problems.length} of ${parsed.teams.length} teams did not import cleanly: ${problems.join("; ")}. Add those rosters by hand in Rosters — re-running the import would create a second league, since there is no way to delete this one.`
      : "";
  return {
    ok: true,
    message: `Imported ${teamCount} teams and ${playerCount} players into "${leagueName}" — ${seasonName}. No games or stats were imported.${shortfall} It's inactive; set it active when ready, and set any goalie positions in Rosters (esportsdesk rarely records them).`,
  };
}

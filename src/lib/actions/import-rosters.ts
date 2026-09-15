"use server";

import { revalidatePath } from "next/cache";
import { redirect, RedirectType } from "next/navigation";
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

// Cosmetic defaults a manager can change per team.
const palette = [
  "#0ea5e9",
  "#b45309",
  "#16a34a",
  "#64748b",
  "#7c3aed",
  "#dc2626",
  "#0891b2",
  "#ca8a04",
  "#475569",
  "#059669",
  "#db2777",
  "#4f46e5",
];

/** Teams and players only, into a new league's first season; esportsdesk records no positions. */
export async function runRosterOnlyImport(
  _prev: ImportRunState,
  formData: FormData,
): Promise<ImportRunState> {
  // Role only: this creates the league, so there is no membership to check yet (exempted in
  // league-guards.test.ts).
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

  // A name with no usable slug is refused before any write: the league would be unreachable,
  // and no UI deletes one.
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
    parsed = await fetchEsportsdeskLeague(
      ids.clientId,
      ids.leagueId,
      sourceSeason,
    );
  } catch (e) {
    return { ok: false, message: `Fetch failed: ${(e as Error).message}` };
  }
  // Checked before the first write: an empty parse (usually a mismatched childSeasonID) would
  // leave a permanent public empty league.
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

  // ⛔ Granted first and checked: a failed grant still imports, but the run must not redirect
  // the manager into a league they cannot open.
  const membership = await addLeagueMembership(manager.id, league.id);
  const accessWarning = membership.ok
    ? ""
    : ` You were NOT added to this league (${membership.error}), so you cannot open it yet — ask a commissioner to add you. Everything else below was imported.`;

  // Filed while the league exists: if the season insert fails, deleting the league cascades
  // this entry away (0031), which is right.
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
    return {
      ok: false,
      message: `Couldn't create the season: ${sErr?.message}`,
    };
  }

  let teamCount = 0;
  let playerCount = 0;
  let ci = 0;
  // Teams that did not import cleanly, named in the result. Each counter moves only after the
  // write it counts has succeeded.
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
    // Counted only once enrolled: a team in no season is absent from every season-scoped view.
    const { error: stErr } = await admin
      .from("season_teams")
      .insert({ season_id: season.id, team_id: team.id });
    if (stErr) {
      problems.push(`${t.name} (not added to the season: ${stErr.message})`);
      continue;
    }
    teamCount++;
    if (t.players.length === 0) continue;

    // Two calls per team, not per player. PostgREST returns inserted rows in input order, so
    // the indexes line up.
    const { data: inserted, error: pErr } = await admin
      .from("players")
      .insert(
        t.players.map((p) => ({
          first_name: p.firstName,
          last_name: p.lastName,
        })),
      )
      .select("id");
    if (pErr || !inserted || inserted.length !== t.players.length) {
      problems.push(
        `${t.name} (players: ${pErr?.message ?? "incomplete insert"})`,
      );
      continue;
    }

    // A jersey is unique per team: repeats get null, and Postgres does not collide nulls.
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
      // The `players` rows above stay, deliberately: deleting on a failure path loses data,
      // and the duplicate-merge tool can absorb them. They are not counted.
      problems.push(`${t.name} (roster: ${rErr.message})`);
      continue;
    }
    playerCount += t.players.length;
  }

  // ⚠️ Above the branch below: both outcomes wrote rows, so both need this revalidation.
  revalidatePath("/[league]/seasons", "page");
  revalidatePath("/[league]", "layout");
  // This import creates a league; the root landing page lists them.
  revalidatePath("/");

  // ⛔ Outside every `try`: `redirect` throws. `replace`, so Back skips the one-shot form. Only
  // when every team landed AND the grant succeeded.
  if (problems.length === 0 && membership.ok)
    redirect(`/${leagueSlug}/seasons`, RedirectType.replace);

  // ⛔ The only place failed teams are named, so this returns. Conditional: a grant failure
  // alone arrives here with `problems` empty.
  const shortfall =
    problems.length > 0
      ? ` ${problems.length} of ${parsed.teams.length} teams did not import cleanly: ${problems.join("; ")}. Those teams are missing or incomplete in the new league — add what you need by hand. Re-running the import would create a second league, since there is no way to delete this one.`
      : "";
  return {
    ok: true,
    slug: leagueSlug,
    canOpen: membership.ok,
    message: `Imported ${teamCount} teams and ${playerCount} players into "${leagueName}" — ${seasonName}. No games or stats were imported.${shortfall} It's inactive; set it active when ready, and set any goalie positions in Rosters (esportsdesk rarely records them).${accessWarning}`,
  };
}

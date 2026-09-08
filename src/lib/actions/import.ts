"use server";

import { revalidatePath } from "next/cache";
import { redirect, RedirectType } from "next/navigation";
import { isReservedLeagueSlug } from "@/lib/league/reserved-slugs";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import { addLeagueMembership } from "@/lib/auth/membership";
import {
  fetchEsportsdeskLeague,
  fetchEsportsdeskSchedule,
  fetchEsportsdeskStats,
  parseEsportsdeskUrl,
  type ParsedLeague,
} from "@/lib/import/esportsdesk";
import { distributeStats } from "@/lib/import/distribute";
import { leagueOffset } from "@/lib/format";
import { slugify } from "@/lib/utils/slug";

/** Normalize a name for matching across esportsdesk pages (roster vs stats). */
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export type ImportPreviewState =
  | { ok: true; preview: ParsedLeague; url: string; gameCount: number }
  | { ok: false; message: string }
  | null;

/** Fetch + parse an esportsdesk league so the manager can review before importing. */
export async function previewEsportsdeskImport(
  _prev: ImportPreviewState,
  formData: FormData,
): Promise<ImportPreviewState> {
  await requireManager();
  const url = String(formData.get("url") ?? "").trim();
  // The esportsdesk childSeasonID to scrape; empty = the league's current season.
  const sourceSeason = String(formData.get("season") ?? "").trim() || null;
  const ids = parseEsportsdeskUrl(url);
  if (!ids) {
    return {
      ok: false,
      message: "Paste an esportsdesk URL that includes clientID and leagueID.",
    };
  }
  try {
    const preview = await fetchEsportsdeskLeague(
      ids.clientId,
      ids.leagueId,
      sourceSeason,
    );
    if (preview.teams.length === 0) {
      return { ok: false, message: "No teams found at that URL." };
    }
    // Schedule is best-effort; a parse failure shouldn't block the roster preview.
    let gameCount = 0;
    try {
      const schedule = await fetchEsportsdeskSchedule(
        ids.clientId,
        ids.leagueId,
        preview.teams.map((t) => t.name),
        preview.season,
      );
      gameCount = schedule.length;
    } catch {
      gameCount = 0;
    }
    return { ok: true, preview, url, gameCount };
  } catch (e) {
    return {
      ok: false,
      message: `Couldn't read from esportsdesk: ${(e as Error).message}`,
    };
  }
}

/**
 * What an import reports back.
 *
 * ⚠️ A SUCCESS HERE IS A *PARTIAL* SUCCESS, and that is the whole shape of it.
 * A clean run never returns — it `redirect`s into the league it just made — so
 * the only way to reach the `ok: true` arm is a run that finished with something
 * to say: a schedule that would not parse, stats that failed, rosters that came
 * up short. That message is the only record of it, which is why those exits
 * return instead of redirecting.
 *
 * `slug` rides along so the page can offer a way into the new league after the
 * manager has read the report. Discriminated rather than `ok: boolean` so the
 * slug is present exactly when there is a league to point at.
 */
export type ImportRunState =
  | { ok: true; slug: string; message: string }
  | { ok: false; message: string }
  | null;

/**
 * Import a parsed esportsdesk league into OBHL: create a new (inactive) league +
 * season and load its teams, players, and rosters. One-time migration — creates
 * fresh records. Positions aren't available on esportsdesk (all default to F);
 * fix goalies in Rosters after.
 */
export async function runEsportsdeskImport(
  _prev: ImportRunState,
  formData: FormData,
): Promise<ImportRunState> {
  // Role only, and deliberately: this creates a league that does not exist
  // yet, so there is no membership to check it against. The page it is
  // submitted from is league-guarded, and the new league's sole member is the
  // manager who made it (granted below).
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
    parsed = await fetchEsportsdeskLeague(
      ids.clientId,
      ids.leagueId,
      sourceSeason,
    );
  } catch (e) {
    return { ok: false, message: `Fetch failed: ${(e as Error).message}` };
  }

  const { data: league, error: lErr } = await admin
    .from("leagues")
    .insert({ name: leagueName, slug: leagueSlug, is_public: true })
    .select("id")
    .single();
  if (lErr) {
    return {
      ok: false,
      message:
        lErr.code === "23505"
          ? `A league named "${leagueName}" already exists — pick a different name.`
          : lErr.message,
    };
  }

  // Before anything else is written: an imported league whose creator is not a
  // member is a league nobody can open, and there is no UI to delete one.
  await addLeagueMembership(manager.id, league.id);

  // Filed here rather than at the end, because the league exists from this line
  // on and every later exit that keeps it reports partial results — two of them
  // return early, both saying `ok: true` with what did and did not import.
  //
  // The one exit below that FAILS deletes the league again (the season insert),
  // and this entry goes with it: `audit_log.league_id` is
  // `references leagues(id) on delete cascade` (0031). So a rolled-back import
  // leaves no entry, which is right — nothing was created.
  //
  // `entity_type: "league"` is the only thing this can be filed against. The
  // season, teams and players it goes on to create are all consequences of the
  // league, and what the run produced is in the message the manager sees; what
  // the log needs to say is that a league appeared and who made it.
  await logAudit({
    user_id: manager.id,
    action: "import_league",
    entity_type: "league",
    entity_id: league.id,
    new_data: { name: leagueName, slug: leagueSlug, source: url },
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
  let teamCount = 0;
  let playerCount = 0;
  let ci = 0;
  const teamIdByName = new Map<string, string>();
  // `${teamId}|j${jersey}` and `${teamId}|n${normName}` → player id, for
  // matching the (separately-scraped) stats rows back to roster players.
  const playerIdByKey = new Map<string, string>();

  for (const t of parsed.teams) {
    const { data: team } = await admin
      .from("teams")
      .insert({
        league_id: league.id,
        name: t.name,
        slug: slugify(t.name),
        color: palette[ci++ % palette.length],
      })
      .select("id")
      .single();
    if (!team) continue;
    teamCount++;
    teamIdByName.set(t.name.toLowerCase(), team.id);
    await admin
      .from("season_teams")
      .insert({ season_id: season.id, team_id: team.id });
    if (t.players.length === 0) continue;

    // Bulk-insert this team's players, then their roster rows — two calls per
    // team instead of two per player (a real import is hundreds of players).
    // PostgREST returns inserted rows in input order, so indexes line up.
    const { data: inserted, error: pErr } = await admin
      .from("players")
      .insert(
        t.players.map((p) => ({
          first_name: p.firstName,
          last_name: p.lastName,
        })),
      )
      .select("id");
    if (pErr || !inserted || inserted.length !== t.players.length) continue;

    // A jersey is unique per team, so only the first wearer keeps the number and
    // later repeats get null (the bulk insert can't lean on a per-row retry).
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
    await admin.from("team_players").insert(rosterRows);

    // Stats rows are matched back to these players by name (preferred) or jersey.
    t.players.forEach((p, i) => {
      const id = inserted[i].id;
      if (p.number != null) playerIdByKey.set(`${team.id}|j${p.number}`, id);
      playerIdByKey.set(
        `${team.id}|n${normName(`${p.firstName}${p.lastName}`)}`,
        id,
      );
    });
    playerCount += t.players.length;
  }

  // Schedule + final results. Best-effort scrape; only games whose two teams
  // both matched the imported rosters are created. Times aren't on the source,
  // so each night's games get default 7:00 / 8:15 / 9:30 slots in date order.
  let gameCount = 0;
  try {
    const schedule = await fetchEsportsdeskSchedule(
      ids.clientId,
      ids.leagueId,
      parsed.teams.map((t) => t.name),
      parsed.season,
    );
    const finalizedAt = new Date().toISOString();
    const slotByDate = new Map<string, number>();
    const rows = schedule
      .map((g) => {
        const home = teamIdByName.get(g.homeName.toLowerCase());
        const away = teamIdByName.get(g.awayName.toLowerCase());
        if (!home || !away) return null;
        const slot = slotByDate.get(g.date) ?? 0;
        slotByDate.set(g.date, slot + 1);
        // 7:00pm + 75-min slots, clamped to 9:45pm so a night with many games
        // can't roll an hour past 23:59 into an invalid timestamp.
        const mins = Math.min(19 * 60 + 75 * slot, 23 * 60 + 45);
        const hh = String(Math.floor(mins / 60)).padStart(2, "0");
        const mm = String(mins % 60).padStart(2, "0");
        return {
          season_id: season.id,
          home_team_id: home,
          away_team_id: away,
          scheduled_at: `${g.date}T${hh}:${mm}:00${leagueOffset(g.date)}`,
          status: "final" as const,
          game_type: (g.isPlayoff ? "playoff" : "regular") as
            "playoff" | "regular",
          home_goals: g.homeGoals,
          away_goals: g.awayGoals,
          result_type: "regulation" as const,
          finalized_at: finalizedAt,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length) {
      const { error: gErr } = await admin.from("games").insert(rows);
      if (gErr) throw new Error(gErr.message);
      gameCount = rows.length;
    }
  } catch (e) {
    // Rosters already imported successfully; surface the schedule failure but
    // don't roll back the (useful) teams + players.
    revalidatePath("/[league]/seasons", "page");
    revalidatePath("/[league]", "layout");
    // This import creates a league; the root landing page lists them.
    revalidatePath("/");
    // ⛔ RETURNS, does not redirect. This message is the only record that the
    // schedule failed, and the manager has to read it before moving on. See the
    // note on `ImportRunState`.
    return {
      ok: true,
      slug: leagueSlug,
      message: `Imported ${teamCount} teams and ${playerCount} players into "${leagueName}" — ${seasonName}, but the schedule import failed (${(e as Error).message}). Delete this league and re-run to retry, or build the schedule manually.`,
    };
  }

  // Player stats. esportsdesk publishes season totals only, so distributeStats
  // spreads each player's line into synthetic per-game box scores (exact season
  // totals; no game shows more skater goals than its final score). Best-effort:
  // standings are already complete, so a stats failure doesn't roll anything back.
  //
  // ⚠️ NOTHING COUNTS THE ROWS ANY MORE. There was a `statRowCount` here, read
  // only by the success message that the redirect below replaced; with no reader
  // left it was a variable kept warm for nobody. If a landing banner ever wants
  // the tally back, it comes from `rosterRows.length` at the end of this block —
  // do not reintroduce the counter until something renders it.
  try {
    const stats = await fetchEsportsdeskStats(
      ids.clientId,
      ids.leagueId,
      parsed.teams.map((t) => t.name),
      parsed.season,
    );
    const { data: gameRows, error: gqErr } = await admin
      .from("games")
      .select("id, home_team_id, away_team_id, home_goals, away_goals")
      .eq("season_id", season.id)
      .eq("game_type", "regular")
      .order("scheduled_at", { ascending: true });
    if (gqErr) throw new Error(gqErr.message);

    const rosterRows: {
      game_id: string;
      team_id: string;
      player_id: string;
      goals: number;
      assists: number;
      pim: number;
    }[] = [];

    for (const t of parsed.teams) {
      const teamId = teamIdByName.get(t.name.toLowerCase());
      if (!teamId || !gameRows) continue;
      const teamGames = gameRows
        .filter((g) => g.home_team_id === teamId || g.away_team_id === teamId)
        .map((g) => ({
          id: g.id,
          cap: (g.home_team_id === teamId ? g.home_goals : g.away_goals) ?? 0,
        }));
      if (!teamGames.length) continue;

      const seenPid = new Set<string>();
      const matched = stats
        .filter((s) => s.team.toLowerCase() === t.name.toLowerCase())
        .map((s) => {
          // Name first: jerseys aren't unique (a team can dress two players on
          // the same number across a season), but names are.
          const pid =
            playerIdByKey.get(`${teamId}|n${normName(s.name)}`) ??
            playerIdByKey.get(`${teamId}|j${s.jersey}`);
          return pid ? { pid, gp: s.gp, g: s.g, a: s.a, pim: s.pim } : null;
        })
        .filter((m): m is NonNullable<typeof m> => m !== null)
        // One roster line per player (guards the game_rosters unique constraint).
        .filter((m) =>
          seenPid.has(m.pid) ? false : (seenPid.add(m.pid), true),
        );
      if (!matched.length) continue;

      const dist = distributeStats(
        teamGames.map((g) => ({ cap: g.cap })),
        matched.map((m) => ({ gp: m.gp, g: m.g, a: m.a, pim: m.pim })),
      );
      matched.forEach((m, pi) => {
        for (const [gi, c] of dist[pi]) {
          rosterRows.push({
            game_id: teamGames[gi].id,
            team_id: teamId,
            player_id: m.pid,
            goals: c.goals,
            assists: c.assists,
            pim: c.pim,
          });
        }
      });
    }

    for (let i = 0; i < rosterRows.length; i += 500) {
      const { error: rErr } = await admin
        .from("game_rosters")
        .insert(rosterRows.slice(i, i + 500));
      if (rErr) throw new Error(rErr.message);
    }
  } catch (e) {
    revalidatePath("/[league]/seasons", "page");
    revalidatePath("/[league]", "layout");
    // This import creates a league; the root landing page lists them.
    revalidatePath("/");
    return {
      ok: true,
      slug: leagueSlug,
      message: `Imported ${teamCount} teams, ${playerCount} players, and ${gameCount} games into "${leagueName}" — ${seasonName}, but player stats failed (${(e as Error).message}). Standings are complete, but there is no way to delete this league and retry — re-running the import would create a second one.`,
    };
  }

  revalidatePath("/[league]/seasons", "page");
  revalidatePath("/[league]", "layout");
  // This import creates a league; the root landing page lists them.
  revalidatePath("/");

  // A clean run ends IN the league it just made, on the page that finishes the
  // job: the season exists but is `is_active: false`, and activating it is the
  // next thing to do. The counts this replaces are dropped — the seasons page
  // showing the new season is the confirmation, and the one hint that message
  // carried alone ("set any goalie positions in Rosters") is already on the
  // import form itself, above the submit button, in both modes.
  //
  // ⛔ THIS LINE MUST STAY OUTSIDE EVERY `try`. `redirect` works by throwing, so
  // one of this file's two `catch (e)` blocks would swallow it and the run would
  // silently fall through — see `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md`,
  // which says so twice. It is safe here because this is the function's top
  // level, after both blocks have closed. The two exits INSIDE those blocks
  // return instead, deliberately: they carry the only report of what failed.
  //
  // `replace` rather than the server-action default of `push`: the create form
  // is a completed one-shot, and leaving it in history means Back lands on a
  // blank form for a league that already exists. (Harmless if anyone gets there
  // — a re-submit hits the unique-slug branch above — but it is a confusing
  // place to be sent.)
  redirect(`/${leagueSlug}/seasons`, RedirectType.replace);
}

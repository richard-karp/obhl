"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import {
  fetchEsportsdeskLeague,
  fetchEsportsdeskSchedule,
  parseEsportsdeskUrl,
  type ParsedLeague,
} from "@/lib/import/esportsdesk";
import { leagueOffset } from "@/lib/format";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

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
  const ids = parseEsportsdeskUrl(url);
  if (!ids) {
    return {
      ok: false,
      message: "Paste an esportsdesk URL that includes clientID and leagueID.",
    };
  }
  try {
    const preview = await fetchEsportsdeskLeague(ids.clientId, ids.leagueId);
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

export type ImportRunState = { ok: boolean; message: string } | null;

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
  await requireManager();
  const url = String(formData.get("url") ?? "");
  const leagueName = String(formData.get("league_name") ?? "").trim();
  const seasonName =
    String(formData.get("season_name") ?? "").trim() || "Imported Season";
  const ids = parseEsportsdeskUrl(url);
  if (!ids || !leagueName) {
    return { ok: false, message: "Missing the source URL or a league name." };
  }

  const admin = createAdminClient();
  let parsed: ParsedLeague;
  try {
    parsed = await fetchEsportsdeskLeague(ids.clientId, ids.leagueId);
  } catch (e) {
    return { ok: false, message: `Fetch failed: ${(e as Error).message}` };
  }

  const { data: league, error: lErr } = await admin
    .from("leagues")
    .insert({ name: leagueName, slug: slugify(leagueName), is_public: true })
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

  const { data: season, error: sErr } = await admin
    .from("seasons")
    .insert({ league_id: league.id, name: seasonName, is_active: false })
    .select("id")
    .single();
  if (sErr || !season) {
    await admin.from("leagues").delete().eq("id", league.id);
    return { ok: false, message: `Couldn't create the season: ${sErr?.message}` };
  }

  const palette = [
    "#0ea5e9", "#b45309", "#16a34a", "#64748b", "#7c3aed", "#dc2626",
    "#0891b2", "#ca8a04", "#475569", "#059669", "#db2777", "#4f46e5",
  ];
  let teamCount = 0;
  let playerCount = 0;
  let ci = 0;
  const teamIdByName = new Map<string, string>();

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
    await admin.from("season_teams").insert({ season_id: season.id, team_id: team.id });

    for (const p of t.players) {
      const { data: player } = await admin
        .from("players")
        .insert({ first_name: p.firstName, last_name: p.lastName })
        .select("id")
        .single();
      if (!player) continue;

      const row = {
        season_id: season.id,
        team_id: team.id,
        player_id: player.id,
        jersey_number: p.number,
        position: "F" as const,
        is_captain: p.isCaptain,
      };
      const { error: tpErr } = await admin.from("team_players").insert(row);
      // Duplicate jersey within the team — keep the player but drop the number.
      if (tpErr?.code === "23505") {
        await admin.from("team_players").insert({ ...row, jersey_number: null });
      }
      playerCount++;
    }
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
        const mins = 19 * 60 + 75 * slot; // 7:00pm + 75-min slots
        const hh = String(Math.floor(mins / 60)).padStart(2, "0");
        const mm = String(mins % 60).padStart(2, "0");
        return {
          season_id: season.id,
          home_team_id: home,
          away_team_id: away,
          scheduled_at: `${g.date}T${hh}:${mm}:00${leagueOffset(g.date)}`,
          status: "final" as const,
          game_type: (g.isPlayoff ? "playoff" : "regular") as
            | "playoff"
            | "regular",
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
    revalidatePath("/seasons");
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: `Imported ${teamCount} teams and ${playerCount} players into "${leagueName}" — ${seasonName}, but the schedule import failed (${(e as Error).message}). The season is inactive; you can re-run or build the schedule manually.`,
    };
  }

  revalidatePath("/seasons");
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: `Imported ${teamCount} teams, ${playerCount} players, and ${gameCount} games into "${leagueName}" — ${seasonName}. It's inactive; set it active when ready, and fix goalie positions in Rosters (esportsdesk doesn't provide positions).`,
  };
}

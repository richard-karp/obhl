"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import { buildBalancedPairings } from "@/lib/schedule/roundRobin";
import { assignNights } from "@/lib/schedule/assignNights";
import { enumerateNights } from "@/lib/schedule/capacity";
import { resolveCurrentLeague } from "@/lib/league/current";
import { leagueOffset } from "@/lib/format";
import type { TablesInsert } from "@/lib/db/helpers";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The season to operate on: an explicit `season_id` from the form (validated to
 * the current league — used by the per-season setup hub), else the active season
 * (used by the standalone /schedule-builder).
 */
async function targetSeason(admin: Admin, formData?: FormData) {
  const league = await resolveCurrentLeague(admin);
  if (!league) return null;

  const explicit = formData ? String(formData.get("season_id") ?? "") : "";
  if (explicit) {
    const { data } = await admin
      .from("seasons")
      .select("id")
      .eq("id", explicit)
      .eq("league_id", league.id)
      .maybeSingle();
    if (data) return data.id;
  }

  const { data: season } = await admin
    .from("seasons")
    .select("id")
    .eq("league_id", league.id)
    .eq("is_active", true)
    .maybeSingle();
  return season?.id ?? null;
}

/**
 * Generate a balanced draft schedule (replaces any existing drafts). The regular
 * season starts at the season's start date and is sized either by a target
 * games-per-team or by an explicit last regular-season night — the season's own
 * end date is the playoff-inclusive boundary and only bounds/warns, it doesn't
 * size the schedule.
 */
export async function generateSchedule(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const seasonId = await targetSeason(admin, formData);
  if (!seasonId) return;

  const { data: season } = await admin
    .from("seasons")
    .select("starts_on, ends_on")
    .eq("id", seasonId)
    .maybeSingle();

  const lengthMode = String(formData.get("length_mode") ?? "games"); // "games" | "date"
  // First game night defaults to the season's start; season end is the outer
  // (playoff-inclusive) bound.
  const startDate = String(formData.get("start_date") ?? "") || season?.starts_on || "";
  const seasonEnd = season?.ends_on ?? "";
  const regSeasonEnd = String(formData.get("reg_season_end") ?? "");
  const gamesPerTeam = Math.max(
    0,
    Math.min(60, Math.floor(Number(formData.get("games_per_team") ?? 0))),
  );
  // Recurring weeknights the league plays (0=Sun..6=Sat) — one or more.
  const weekdays = new Set(formData.getAll("weekdays").map((d) => Number(d)));
  // Dates to skip (weeks off / holidays).
  const excluded = new Set(
    String(formData.get("excluded_dates") ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const slotTimes = String(formData.get("slot_times") ?? "19:00,20:15,21:30")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!startDate || weekdays.size === 0 || slotTimes.length === 0) return;

  const { data: enrolled } = await admin
    .from("season_teams")
    .select("team_id")
    .eq("season_id", seasonId);
  const teamIds = (enrolled ?? []).map((e) => e.team_id);
  if (teamIds.length < 2) return;

  const perNightCap = Math.min(slotTimes.length, Math.floor(teamIds.length / 2));
  let games;

  if (lengthMode === "date") {
    // Fill the window up to the last regular-season night. Derive games-per-team
    // by placement: start from the capacity estimate and step down until every
    // pairing fits (so the draft is never reported as incomplete).
    if (!regSeasonEnd) return;
    const nights = enumerateNights(startDate, {
      weekdays,
      slotTimes,
      excluded,
      endDate: regSeasonEnd,
    });
    if (nights.length === 0) return;
    let g = Math.max(1, Math.floor((2 * nights.length * perNightCap) / teamIds.length));
    let result = assignNights(buildBalancedPairings(teamIds, g), nights, teamIds);
    // The estimate is an upper bound; step down until everything fits. Capped so
    // a bad estimate can't trigger many expensive placement runs — a remaining
    // shortfall just surfaces the "incomplete" banner.
    for (let tries = 0; tries < 8 && g > 1 && result.report.unscheduled > 0; tries++) {
      g -= 1;
      result = assignNights(buildBalancedPairings(teamIds, g), nights, teamIds);
    }
    games = result.games;
  } else {
    // Size by target games-per-team; the last game date falls out of placement.
    if (gamesPerTeam < 1) return;
    const pairings = buildBalancedPairings(teamIds, gamesPerTeam);
    // Use exactly the nights the games need — surplus nights only create byes
    // (empty ice a team sits out). Grow slightly only if placement can't fit,
    // and never schedule past the playoff-inclusive season end.
    const minNights = Math.ceil(
      (gamesPerTeam * teamIds.length) / (2 * perNightCap),
    );
    let result: ReturnType<typeof assignNights> | undefined;
    let prevCount = -1;
    for (let extra = 0; extra <= 8; extra += 2) {
      const nights = enumerateNights(startDate, {
        weekdays,
        slotTimes,
        excluded,
        endDate: seasonEnd || undefined,
        maxNights: minNights + extra,
      });
      if (nights.length === 0) return;
      if (nights.length === prevCount) break; // capped by season end; more won't help
      prevCount = nights.length;
      result = assignNights(pairings, nights, teamIds);
      if (result.report.unscheduled === 0) break;
    }
    if (!result) return;
    games = result.games;
  }

  // Replace existing drafts.
  await admin.from("games").delete().eq("season_id", seasonId).eq("is_draft", true);
  if (games.length) {
    await admin.from("games").insert(
      games.map((g) => ({
        season_id: seasonId,
        home_team_id: g.home,
        away_team_id: g.away,
        // Per-game offset so games on either side of the DST switch keep the
        // right wall-clock time.
        scheduled_at: `${g.scheduledAt}${leagueOffset(g.scheduledAt)}`,
        status: "scheduled" as const,
        round: g.round,
        is_draft: true,
      })),
    );
  }
  revalidatePath("/schedule-builder");
  revalidatePath(`/seasons/${seasonId}`);
}

/** Publish the draft schedule (drafts become live games). */
export async function publishSchedule(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const seasonId = await targetSeason(admin, formData);
  if (!seasonId) return;
  await admin
    .from("games")
    .update({ is_draft: false })
    .eq("season_id", seasonId)
    .eq("is_draft", true);
  revalidatePath("/schedule-builder");
  revalidatePath(`/seasons/${seasonId}`);
  revalidatePath("/schedule");
  revalidatePath("/");
}

/** Discard all draft games for the season. */
export async function discardSchedule(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const seasonId = await targetSeason(admin, formData);
  if (!seasonId) return;
  await admin.from("games").delete().eq("season_id", seasonId).eq("is_draft", true);
  revalidatePath("/schedule-builder");
  revalidatePath(`/seasons/${seasonId}`);
}

export type ScheduleGameState = { ok: boolean; message: string } | null;

/**
 * Schedule the tournament's labeled games — either a Final (one matchup) or two
 * Semifinals — between chosen teams, added on top of the existing schedule (NOT
 * a regeneration). They still count as season games. Optionally pairs the
 * remaining teams into games on the same night's other ice times so they play.
 */
export async function scheduleSpecialGame(
  _prev: ScheduleGameState,
  formData: FormData,
): Promise<ScheduleGameState> {
  await requireManager();
  const admin = createAdminClient();
  const seasonId = await targetSeason(admin, formData);
  if (!seasonId) return { ok: false, message: "No season selected." };

  const round = String(formData.get("round") ?? "final");
  const date = String(formData.get("date") ?? "");
  const fill = formData.get("fill_others") === "on";
  const slots = String(formData.get("slots") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // The labeled tournament games to create.
  type Designated = { home: string; away: string; label: string };
  let designated: Designated[];
  if (round === "semifinals") {
    designated = [
      {
        home: String(formData.get("sf1_home") ?? ""),
        away: String(formData.get("sf1_away") ?? ""),
        label: "Semifinal 1",
      },
      {
        home: String(formData.get("sf2_home") ?? ""),
        away: String(formData.get("sf2_away") ?? ""),
        label: "Semifinal 2",
      },
    ];
  } else {
    designated = [
      {
        home: String(formData.get("home_team_id") ?? ""),
        away: String(formData.get("away_team_id") ?? ""),
        label: String(formData.get("label") ?? "").trim() || "Final",
      },
    ];
  }

  if (designated.some((d) => !d.home || !d.away)) {
    return { ok: false, message: "Pick both teams for each game." };
  }
  if (designated.some((d) => d.home === d.away)) {
    return { ok: false, message: "Each game needs two different teams." };
  }
  const used = designated.flatMap((d) => [d.home, d.away]);
  if (new Set(used).size !== used.length) {
    return { ok: false, message: "A team can't be in two tournament games the same night." };
  }
  if (!date || slots.length === 0) {
    return { ok: false, message: "Pick a date and at least one ice time." };
  }
  if (slots.length < designated.length) {
    return { ok: false, message: `Add at least ${designated.length} ice times for these games.` };
  }

  const { data: enrolled } = await admin
    .from("season_teams")
    .select("team_id")
    .eq("season_id", seasonId);
  const teamIds = (enrolled ?? []).map((e) => e.team_id);
  if (used.some((t) => !teamIds.includes(t))) {
    return { ok: false, message: "All teams must be enrolled this season." };
  }

  // Avoid double-booking: who already plays (non-cancelled) that date?
  const { data: dayGames } = await admin
    .from("games")
    .select("home_team_id, away_team_id")
    .eq("season_id", seasonId)
    .neq("status", "cancelled")
    .gte("scheduled_at", `${date}T00:00:00${leagueOffset(date)}`)
    .lte("scheduled_at", `${date}T23:59:59${leagueOffset(date)}`);
  const busy = new Set<string>();
  for (const g of dayGames ?? []) {
    busy.add(g.home_team_id);
    busy.add(g.away_team_id);
  }
  if (used.some((t) => busy.has(t))) {
    return { ok: false, message: "One of the chosen teams already plays that date." };
  }

  // Designated games take the last (feature) slots; fillers take the earlier ones.
  const desSlots = slots.slice(slots.length - designated.length);
  const fillerSlots = slots.slice(0, slots.length - designated.length);
  const rows: TablesInsert<"games">[] = designated.map((d, i) => ({
    season_id: seasonId,
    home_team_id: d.home,
    away_team_id: d.away,
    scheduled_at: `${date}T${desSlots[i]}:00${leagueOffset(date)}`,
    status: "scheduled",
    label: d.label,
  }));

  let fillers = 0;
  if (fill) {
    const usedSet = new Set(used);
    const others = teamIds.filter((t) => !usedSet.has(t) && !busy.has(t));
    for (let i = 0, si = 0; i + 1 < others.length && si < fillerSlots.length; i += 2, si++) {
      rows.push({
        season_id: seasonId,
        home_team_id: others[i],
        away_team_id: others[i + 1],
        scheduled_at: `${date}T${fillerSlots[si]}:00${leagueOffset(date)}`,
        status: "scheduled",
      });
      fillers++;
    }
  }

  const { error } = await admin.from("games").insert(rows);
  if (error) return { ok: false, message: error.message };

  revalidatePath("/schedule-builder");
  revalidatePath(`/seasons/${seasonId}`);
  revalidatePath("/schedule");
  revalidatePath("/");
  const what = round === "semifinals" ? "2 semifinals" : "the Final";
  return {
    ok: true,
    message: `Scheduled ${what}${fillers ? ` + ${fillers} other game${fillers > 1 ? "s" : ""}` : ""}.`,
  };
}

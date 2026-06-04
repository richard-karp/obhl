"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import { roundRobin } from "@/lib/schedule/roundRobin";
import { assignNights, type Night } from "@/lib/schedule/assignNights";
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

/** Generate a balanced draft schedule (replaces any existing drafts). */
export async function generateSchedule(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const seasonId = await targetSeason(admin, formData);
  if (!seasonId) return;

  const cycles = Math.max(1, Number(formData.get("cycles") ?? 1));
  const startDate = String(formData.get("start_date") ?? "");
  const endDate = String(formData.get("end_date") ?? "");
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
  if (!startDate || !endDate || weekdays.size === 0 || slotTimes.length === 0) {
    return;
  }

  const { data: enrolled } = await admin
    .from("season_teams")
    .select("team_id")
    .eq("season_id", seasonId);
  const teamIds = (enrolled ?? []).map((e) => e.team_id);
  if (teamIds.length < 2) return;

  // Build the chronological night list: every selected weekday in [start, end],
  // minus excluded dates. UTC arithmetic so DST never shifts a day.
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const endU = Date.UTC(ey, em - 1, ed);
  const nights: Night[] = [];
  for (
    let cur = Date.UTC(sy, sm - 1, sd), guard = 0;
    cur <= endU && guard < 730;
    cur += 86400000, guard++
  ) {
    const date = new Date(cur).toISOString().slice(0, 10);
    if (weekdays.has(new Date(cur).getUTCDay()) && !excluded.has(date)) {
      nights.push({ date, slots: slotTimes });
    }
  }
  if (nights.length === 0) return;

  const { games } = assignNights(roundRobin(teamIds, cycles), nights, teamIds);

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

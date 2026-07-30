"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManager } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import { buildBalancedPairings } from "@/lib/schedule/roundRobin";
import { assignNights } from "@/lib/schedule/assignNights";
import { enumerateNights } from "@/lib/schedule/capacity";
import { resolveCurrentLeague } from "@/lib/league/current";
import {
  planOneOff,
  checkOneOffWrite,
  buildOneOffRows,
  type OneOffNight,
  type OneOffPlan,
  type OneOffRound,
} from "@/lib/schedule/oneOff";
import { getSeasonNights, type SeasonNight } from "@/lib/queries/schedule";
import { getEnrolledTeams } from "@/lib/queries/teams";
import { leagueOffset, formatGameTime } from "@/lib/format";
import type { TablesInsert } from "@/lib/db/helpers";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The season to operate on: an explicit `season_id` from the form (validated to
 * the current league — used by the per-season setup hub), else the active season
 * (used by the standalone /schedule-builder).
 *
 * An explicit id that doesn't resolve returns null rather than falling back.
 * Falling back retargets the write at a season the manager never named: the
 * `obhl_league` cookie is global, so switching league in a second tab makes the
 * first tab's `/seasons/<A>` form resolve against league B, where season A
 * doesn't exist. Every action here now replaces or repairs a published
 * schedule, so the fallback's cost is league B's active season losing its games
 * — refusing is the only safe reading of "I asked for A and A isn't here".
 */
async function targetSeason(admin: Admin, explicit = "") {
  const league = await resolveCurrentLeague(admin);
  if (!league) return null;

  if (explicit) {
    const { data } = await admin
      .from("seasons")
      .select("id")
      .eq("id", explicit)
      .eq("league_id", league.id)
      .maybeSingle();
    return data?.id ?? null;
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
  const seasonId = await targetSeason(admin, String(formData.get("season_id") ?? ""));
  if (!seasonId) return;

  // A started season can't publish, so it shouldn't accept a draft either —
  // generating one would only produce a preview that can never be applied. Same
  // rule as the publish gate, read from the same function.
  //
  // Fail closed on an RPC error, matching getPublishState: if we can't tell
  // whether the season has started, don't generate. Reading the error as "not
  // started" is the wrong way round — it discards the season's existing drafts
  // (see the delete further down) to build a preview that is refused at publish
  // time, and it makes this the one place in the feature where an unreadable
  // gate means "go ahead".
  const { data: startedGuard, error: startedError } = await admin.rpc(
    "season_is_started",
    { p_season: seasonId },
  );
  if (startedError || startedGuard !== false) return;

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

  // Alphabetical, so the same enrolment always feeds the generator in the same
  // order and a re-run is reproducible.
  const teamIds = (await getEnrolledTeams(seasonId, { client: admin })).map((t) => t.id);
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

export type PublishState = { ok: boolean; message: string } | null;

/**
 * Publish the draft schedule, replacing whatever is already live.
 *
 * The delete and the promotion happen inside `replace_published_schedule` so
 * they commit together — as two calls from here, a failure between them would
 * leave the season with no games at all, the old schedule gone and the new one
 * still in draft.
 *
 * Refusals are ordinary outcomes of a stale page, not faults: the manager's tab
 * may have been open since before the first game was played, or the draft may
 * have been discarded in another tab. Both come back as a message.
 */
export async function publishSchedule(
  _prev: PublishState,
  formData: FormData,
): Promise<PublishState> {
  const user = await requireManager();
  const admin = createAdminClient();
  const seasonId = await targetSeason(admin, String(formData.get("season_id") ?? ""));
  if (!seasonId) return { ok: false, message: "No season selected." };

  const { data, error } = await admin.rpc("replace_published_schedule", {
    p_season: seasonId,
  });
  if (error) return { ok: false, message: error.message };

  const row = data?.[0];
  if (!row) return { ok: false, message: "Nothing happened — try again." };

  if (row.refused === "started") {
    return {
      ok: false,
      message: "The season is under way — the schedule can no longer be replaced.",
    };
  }
  if (row.refused === "no_draft") {
    return { ok: false, message: "There's no draft to publish." };
  }

  // A replace deletes live games, which is the most destructive thing a manager
  // can do here. A first publish deletes nothing and stays unaudited, matching
  // the bar the rest of games.ts sets.
  if (row.deleted > 0) {
    void logAudit({
      user_id: user.id,
      action: "replace_schedule",
      entity_type: "season",
      entity_id: seasonId,
      old_data: { published_games: row.deleted },
      new_data: { published_games: row.published },
    });
  }

  revalidatePath("/schedule-builder");
  revalidatePath(`/seasons/${seasonId}`);
  revalidatePath("/schedule");
  // The scoring list reads through getSchedule, so a replace changes which games
  // it shows. The old publishSchedule didn't revalidate it either — that gap was
  // invisible while publishing only ever added games.
  revalidatePath("/score");
  revalidatePath("/");

  return {
    ok: true,
    message:
      row.deleted > 0
        ? `Replaced the published schedule — removed ${row.deleted} games, published ${row.published}.`
        : `Published ${row.published} games.`,
  };
}

/** Discard all draft games for the season. */
export async function discardSchedule(formData: FormData) {
  await requireManager();
  const admin = createAdminClient();
  const seasonId = await targetSeason(admin, String(formData.get("season_id") ?? ""));
  if (!seasonId) return;
  await admin.from("games").delete().eq("season_id", seasonId).eq("is_draft", true);
  revalidatePath("/schedule-builder");
  revalidatePath(`/seasons/${seasonId}`);
}

/* ------------------------------------------------------------------ one-off */

// `OneOffRound` lives in `@/lib/schedule/oneOff` alongside the labelling it
// drives. Declaring a type here is fine (see `OneOffInput` below), but
// *re-exporting* one — `export type { OneOffRound }` — is not: in a "use server"
// module it compiles, then fails the build as a missing server action.

export type OneOffInput = {
  seasonId: string;
  round: OneOffRound;
  /** Team-id pairs for the labelled game(s); orientation is the repair's call. */
  matchups: [string, string][];
  label: string;
  /** League-local YYYY-MM-DD — must be one of the season's unlocked nights. */
  date: string;
  /** Hold the labelled game(s) on the night's last ice time(s). */
  featureSlot: boolean;
};

export type OneOffPreview = {
  /** Index-aligned with the planner's team indices. */
  teams: { id: string; name: string }[];
  /** Index-aligned with the planner's night indices. */
  nights: { date: string; times: string[]; locked: boolean }[];
  oneOffNight: number;
  relabelOnly: boolean;
  plans: OneOffPlan[];
};

export type OneOffState =
  | null
  | { ok: false; message: string }
  | { ok: true; kind: "preview"; preview: OneOffPreview }
  | { ok: true; kind: "applied"; message: string };

/**
 * Everything both actions need: the season's nights, its enrolled teams, and the
 * index mapping the planner works in. Read fresh on both sides, so apply
 * validates against the schedule as it is now, not as it was at preview.
 */
async function loadContext(seasonId: string, admin: Admin) {
  // Read as the admin client, not under RLS. Both actions are manager-gated and
  // work on a season the manager named, so RLS adds nothing — while a season
  // the public-read policies don't cover would come back empty rather than
  // erroring, and the repair would silently plan against an empty schedule.
  const [enrolled, nights] = await Promise.all([
    getEnrolledTeams(seasonId, { client: admin }),
    getSeasonNights(seasonId, { client: admin }),
  ]);
  const teams = enrolled.map((t) => ({ id: t.id, name: t.name }));
  const indexOf = new Map(teams.map((t, i) => [t.id, i]));
  return { teams, indexOf, nights };
}

/** The planner's index-based view of the season, or null if a team is unknown. */
function toPlannerNights(
  nights: SeasonNight[],
  indexOf: Map<string, number>,
): OneOffNight[] | null {
  const out: OneOffNight[] = [];
  for (const n of nights) {
    const games: [number, number][] = [];
    for (const g of n.games) {
      const h = indexOf.get(g.homeTeamId);
      const a = indexOf.get(g.awayTeamId);
      if (h === undefined || a === undefined) return null;
      games.push([h, a]);
    }
    out.push({ date: n.date, games, locked: n.locked });
  }
  return out;
}

function readInput(
  input: Pick<OneOffInput, "matchups" | "date">,
  indexOf: Map<string, number>,
) {
  if (input.matchups.length === 0) return "Pick the teams for the game.";
  for (const [h, a] of input.matchups) {
    if (!h || !a) return "Pick both teams for each game.";
    if (h === a) return "Each game needs two different teams.";
    if (!indexOf.has(h) || !indexOf.has(a)) {
      return "All teams must be enrolled this season.";
    }
  }
  if (!input.date) return "Pick a date.";
  return null;
}

/**
 * Plan a one-off and the repair that follows it. Reads only — nothing is written
 * until the manager picks a plan and `applyOneOffGame` runs.
 */
export async function previewOneOffGame(
  input: OneOffInput,
): Promise<OneOffState> {
  await requireManager();
  const admin = createAdminClient();
  const seasonId = await targetSeason(admin, input.seasonId);
  if (!seasonId) return { ok: false, message: "No season selected." };

  const { teams, indexOf, nights } = await loadContext(seasonId, admin);
  const bad = readInput(input, indexOf);
  if (bad) return { ok: false, message: bad };

  const plannerNights = toPlannerNights(nights, indexOf);
  if (!plannerNights) {
    return {
      ok: false,
      message: "The schedule has a game for a team that isn't enrolled this season.",
    };
  }

  const oneOffNight = nights.findIndex((n) => n.date === input.date);
  if (oneOffNight < 0) {
    return { ok: false, message: "That date isn't a game night this season." };
  }

  const result = planOneOff({
    teamCount: teams.length,
    nights: plannerNights,
    oneOffNight,
    forcedPairs: input.matchups.map(
      ([h, a]) => [indexOf.get(h)!, indexOf.get(a)!] as [number, number],
    ),
    featureSlot: input.featureSlot,
  });
  if (!result.ok) return { ok: false, message: result.reason };

  return {
    ok: true,
    kind: "preview",
    preview: {
      teams,
      nights: nights.map((n) => ({
        date: n.date,
        times: n.games.map((g) => formatGameTime(g.scheduledAt)),
        locked: n.locked,
      })),
      oneOffNight,
      relabelOnly: result.relabelOnly,
      plans: result.plans,
    },
  };
}

/**
 * Write a previewed plan.
 *
 * The submitted changes are *validated*, not re-solved. Re-solving can't work:
 * both `assignMatchups` and `assignSlots` stop on a wall-clock deadline, so two
 * runs may legitimately differ and apply would fail spuriously. Validation is
 * also the stronger guarantee — these checks are the invariant itself, so any
 * payload that passes them preserves games-played, byes and weekday balance
 * whatever the client sent.
 *
 * Changes are keyed by **date, not by position**. Preview and apply read the
 * schedule independently, so a game added or re-dated in between would shift
 * every later index and silently write the plan to the wrong nights — and the
 * participant check wouldn't catch it in a league where every team plays every
 * night, which is the common small-league shape. A date that no longer exists
 * fails closed instead.
 *
 * Ice times are never written. A night's games keep their existing rows in time
 * order and only their matchups move, so "the set of times per night is
 * unchanged" holds structurally rather than by assertion.
 */
export async function applyOneOffGame(
  // `featureSlot` is deliberately absent: it steers the *planner*, and by this
  // point the chosen plan already encodes which game sits on which ice time.
  input: Omit<OneOffInput, "featureSlot"> & {
    changes: { date: string; to: [number, number][] }[];
  },
): Promise<OneOffState> {
  await requireManager();
  const admin = createAdminClient();
  const seasonId = await targetSeason(admin, input.seasonId);
  if (!seasonId) return { ok: false, message: "No season selected." };

  const { teams, indexOf, nights } = await loadContext(seasonId, admin);
  const bad = readInput(input, indexOf);
  if (bad) return { ok: false, message: bad };

  const teamIds = teams.map((t) => t.id);

  // Everything standing between a client payload and the write. Pure and
  // tested in oneOff.test.ts; see `checkOneOffWrite` for why it validates
  // rather than re-solves.
  const problem = checkOneOffWrite({
    nights: nights.map((n) => ({
      date: n.date,
      locked: n.locked,
      games: n.games.map((g) => [g.homeTeamId, g.awayTeamId] as [string, string]),
    })),
    teamIds,
    date: input.date,
    forcedPairs: input.matchups,
    changes: input.changes,
  });
  if (problem) return { ok: false, message: problem };

  // Which rows the plan writes, and what goes in them — pure, and tested in
  // oneOff.test.ts. Everything left here is the I/O either side of it.
  const rows: TablesInsert<"games">[] = buildOneOffRows({
    nights,
    teamIds,
    date: input.date,
    round: input.round,
    label: input.label,
    forcedPairs: input.matchups,
    changes: input.changes,
  }).map((r) => ({
    id: r.id,
    season_id: seasonId,
    home_team_id: r.homeTeamId,
    away_team_id: r.awayTeamId,
    label: r.label,
    // The game's own scheduled_at as we just read it, so this is a no-op for the
    // row it targets. It's here because `upsert` *inserts* when no row matches
    // the id, and if this game were deleted between the read and the write that
    // insert would otherwise create a game with no date at all.
    //
    // Deliberately not the date the night was derived from: a postponed game's
    // is null, and writing back postponed_from would restore a date that was
    // cleared on purpose.
    scheduled_at: r.scheduledAt,
  }));

  if (rows.length > 0) {
    // One statement, so a plan can't land half-applied.
    const { error } = await admin.from("games").upsert(rows, { onConflict: "id" });
    if (error) return { ok: false, message: error.message };
  }

  revalidatePath("/schedule-builder");
  revalidatePath("/schedule-builder/one-off");
  revalidatePath(`/seasons/${seasonId}`);
  revalidatePath("/schedule");
  revalidatePath("/score");
  revalidatePath("/");

  const touched = input.changes.length;
  return {
    ok: true,
    kind: "applied",
    message:
      touched === 0
        ? "Labelled the game — nothing else needed to change."
        : `Scheduled the game and adjusted ${touched} night${touched === 1 ? "" : "s"}.`,
  };
}

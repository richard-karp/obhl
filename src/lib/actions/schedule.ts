"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueManager } from "@/lib/auth/guards";
import { leagueOfSeason } from "@/lib/league/of-entity";
import { logAudit } from "@/lib/audit";
import { buildBalancedPairings } from "@/lib/schedule/roundRobin";
import { assignNights } from "@/lib/schedule/assignNights";
import { enumerateNights } from "@/lib/schedule/capacity";
import { isPastGameNight } from "@/lib/schedule/startDate";
import {
  shiftDateByWeeks,
  staleDraft,
  type StaleDraft,
} from "@/lib/schedule/staleDraft";
import {
  planOneOff,
  planRepair,
  checkOneOffWrite,
  buildOneOffRows,
  type OneOffNight,
  type OneOffPlan,
  type OneOffRound,
  type RepairPin,
} from "@/lib/schedule/oneOff";
import {
  getScheduleConstraints,
  getSeasonNights,
  readWithOneRetry,
  type SeasonNight,
} from "@/lib/queries/schedule";
import { checkNightMove, moveNightTo } from "@/lib/schedule/nights";
// ⛔ Imported, never exported from here: every export of a "use server" module is a
// client-callable action, and this one takes an admin client.
import { writeGames } from "@/lib/schedule/writeGames";
import { MAX_GAME_WRITES } from "@/lib/schedule/gameWrites";
import {
  constraintConflicts,
  describeConstraint,
  isConstraintKind,
  refuteConstraints,
  resolveConstraints,
  type ConstraintParams,
} from "@/lib/schedule/constraints";
import { buildNightMeta } from "@/lib/schedule/spacing";
import { distributeGames } from "@/lib/schedule/assignNights";
import { getEnrolledTeams } from "@/lib/queries/teams";
import {
  leagueOffset,
  formatGameTime,
  formatLongDate,
  leagueTimeKey,
  leagueDateKey,
} from "@/lib/format";

type Admin = ReturnType<typeof createAdminClient>;

// The form's season, or null: every action here replaces or repairs a schedule, so a missing or
// unknown season is refused, never guessed.
async function targetSeason(admin: Admin, explicit = "") {
  if (!explicit) return null;

  const { data } = await admin
    .from("seasons")
    .select("id")
    .eq("id", explicit)
    .maybeSingle();
  return data?.id ?? null;
}

// Resolves the league from the season and checks membership: the season lookup alone only proves
// the id exists somewhere.
async function targetSeasonForManager(admin: Admin, explicit = "") {
  const seasonId = await targetSeason(admin, explicit);
  if (!seasonId) return null;
  const manager = await requireLeagueManager(() =>
    leagueOfSeason(seasonId, admin),
  );
  return { seasonId, manager };
}

export type ConstraintState = { ok: boolean; message: string } | null;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

/** "9:00" and "09:00" are the same ice time; the generator compares strings. */
function normalizeTime(raw: string): string | null {
  if (!TIME_RE.test(raw)) return null;
  const [h, m] = raw.split(":");
  // `TIME_RE` admits "99:99", which would be stored and never match a slot.
  if (Number(h) > 23 || Number(m) > 59) return null;
  return `${h.padStart(2, "0")}:${m}`;
}

// Stores what the manager meant (a date, a week-of date, a wall-clock time), never a week number
// or slot position: see 0039's header.
function readConstraintParams(
  kind: string,
  formData: FormData,
): { params: ConstraintParams } | { error: string } {
  const field = (n: string) => String(formData.get(n) ?? "").trim();
  switch (kind) {
    case "bye_on":
    case "play_on": {
      const date = field("constraint_date");
      if (!DATE_RE.test(date))
        return { error: "Pick a date for that request." };
      return { params: { date } };
    }
    case "bye_week":
    case "bye_in_week": {
      const week_of = field("constraint_week_of");
      if (!DATE_RE.test(week_of)) {
        return { error: "Pick a date in the week for that request." };
      }
      return { params: { week_of } };
    }
    case "slot_on": {
      const date = field("constraint_date");
      const time = normalizeTime(field("constraint_time"));
      if (!DATE_RE.test(date))
        return { error: "Pick a date for that request." };
      if (!time) return { error: "Enter the ice time as HH:MM." };
      return { params: { date, time } };
    }
    case "slot_bias": {
      const from = field("constraint_from");
      const to = field("constraint_to");
      const prefer = field("constraint_prefer") === "late" ? "late" : "early";
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
        return { error: "Pick both ends of the date range." };
      }
      if (from > to) return { error: "That date range ends before it starts." };
      return { params: { from, to, prefer } };
    }
    default:
      return { error: "Unknown constraint type." };
  }
}

// Not validated against a calendar: none exists until generation, where a date that is not a game
// night is reported unmet.
export async function saveScheduleConstraint(
  _prev: ConstraintState,
  formData: FormData,
): Promise<ConstraintState> {
  const admin = createAdminClient();
  const target = await targetSeasonForManager(
    admin,
    String(formData.get("season_id") ?? ""),
  );
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId, manager } = target;

  const kind = String(formData.get("constraint_kind") ?? "");
  if (!isConstraintKind(kind)) {
    return { ok: false, message: "Pick what the request should do." };
  }
  const teamId = String(formData.get("constraint_team_id") ?? "");
  // Enrolment, not mere existence: the generator only sees this season's teams.
  const enrolled = await getEnrolledTeams(seasonId, { client: admin });
  const team = enrolled.find((t) => t.id === teamId);
  if (!team) {
    return { ok: false, message: "Pick a team enrolled in this season." };
  }

  const read = readConstraintParams(kind, formData);
  if ("error" in read) return { ok: false, message: read.error };

  const { data, error } = await admin
    .from("season_schedule_constraints")
    .insert({ season_id: seasonId, team_id: teamId, kind, params: read.params })
    .select("id")
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      message: `Couldn't save that request. ${error.message}`,
    };
  }

  if (data?.id) {
    void logAudit({
      user_id: manager.id,
      action: "add_schedule_constraint",
      entity_type: "schedule_constraint",
      entity_id: data.id,
      new_data: {
        season_id: seasonId,
        team_id: teamId,
        kind,
        params: read.params,
      },
    });
  }
  revalidatePath("/[league]/seasons/[seasonId]", "page");
  return {
    ok: true,
    message: `Added: ${describeConstraint({ kind, params: read.params }, team.name)}.`,
  };
}

export async function deleteScheduleConstraint(
  _prev: ConstraintState,
  formData: FormData,
): Promise<ConstraintState> {
  const admin = createAdminClient();
  const constraintId = String(formData.get("constraint_id") ?? "");
  if (!constraintId) return { ok: false, message: "No request selected." };

  // Read before the delete: the guard needs its season, and afterwards the audit entry would file
  // under a null league and be hidden (`RUNBOOK.md` → Access control → Traps).
  const { data: row } = await admin
    .from("season_schedule_constraints")
    .select("id, season_id, team_id, kind, params")
    .eq("id", constraintId)
    .maybeSingle();
  if (!row) return { ok: false, message: "That request no longer exists." };

  const leagueId = await leagueOfSeason(row.season_id, admin);
  const manager = await requireLeagueManager(() => Promise.resolve(leagueId));

  const { error } = await admin
    .from("season_schedule_constraints")
    .delete()
    .eq("id", constraintId);
  if (error) {
    return {
      ok: false,
      message: `Couldn't remove that request. ${error.message}`,
    };
  }

  void logAudit({
    user_id: manager.id,
    action: "remove_schedule_constraint",
    entity_type: "schedule_constraint",
    entity_id: constraintId,
    league_id: leagueId,
    old_data: {
      season_id: row.season_id,
      team_id: row.team_id,
      kind: row.kind,
      params: row.params,
    },
  });
  revalidatePath("/[league]/seasons/[seasonId]", "page");
  return { ok: true, message: "Removed that request." };
}

export type GenerateState = { ok: boolean; message: string } | null;

// Replaces the drafts. Sized by games per team or a last regular-season night; the season's end is
// playoff-inclusive and only bounds. Every refusal returns its own message.
export async function generateSchedule(
  _prev: GenerateState,
  formData: FormData,
): Promise<GenerateState> {
  const admin = createAdminClient();
  const target = await targetSeasonForManager(
    admin,
    String(formData.get("season_id") ?? ""),
  );
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId } = target;

  // A started season cannot publish, so it takes no draft. Fails closed: an unreadable gate would
  // delete the drafts below for a preview that publish refuses.
  const { data: startedGuard, error: startedError } = await admin.rpc(
    "season_is_started",
    { p_season: seasonId },
  );
  if (startedError) {
    return {
      ok: false,
      message:
        "Couldn't check whether the season has started — nothing was changed.",
    };
  }
  if (startedGuard !== false) {
    return {
      ok: false,
      message:
        "The season is under way — a draft schedule can no longer be generated.",
    };
  }

  const { data: season } = await admin
    .from("seasons")
    .select("starts_on, ends_on")
    .eq("id", seasonId)
    .maybeSingle();

  const lengthMode = String(formData.get("length_mode") ?? "games"); // "games" | "date"
  // First game night defaults to the season's start; season end is the outer
  // (playoff-inclusive) bound.
  const startDate =
    String(formData.get("start_date") ?? "") || season?.starts_on || "";
  const seasonEnd = season?.ends_on ?? "";
  const regSeasonEnd = String(formData.get("reg_season_end") ?? "");
  const gamesPerTeam = Math.max(
    0,
    Math.min(60, Math.floor(Number(formData.get("games_per_team") ?? 0))),
  );
  // Which equally valid schedule to build. Output repeats for a given input while the search
  // finishes inside its time budget (`PLATEAU_SEEDS`). ⚠️ Not persisted: a reload restarts at 1.
  const variation = Math.max(
    1,
    Math.min(50, Math.floor(Number(formData.get("variation") ?? 1)) || 1),
  );
  // Weeknights, 0=Sun..6=Sat. ⛔ Range-checked, since they persist in `seasons.game_nights`, where
  // `Number("")` would silently become Sunday.
  const weekdays = new Set(
    formData
      .getAll("weekdays")
      .map((d) => Number(String(d).trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
  );
  // Dates to skip (weeks off / holidays).
  const excluded = new Set(
    String(formData.get("excluded_dates") ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // ⛔ Normalised: `slot_on` pins match these by string equality against a zero-padded time, so an
  // unpadded "9:00" here leaves every pin at that time unmet.
  const slotTimes = String(formData.get("slot_times") ?? "19:00,20:20,21:40")
    .split(",")
    .map((s) => s.trim())
    // Unparseable entries pass through: dropping one would change how many games a night holds.
    .map((s) => normalizeTime(s) ?? s)
    .filter(Boolean);
  if (!startDate) return { ok: false, message: "Pick a first game night." };
  // ⛔ A past-dated draft passes `season_is_started` (it counts only published games), then locks
  // the season at publish (`RUNBOOK.md` → Deploy and operations → Hazards). Refused here instead.
  if (
    isPastGameNight({
      startDate,
      today: leagueDateKey(new Date().toISOString()),
    })
  ) {
    return {
      ok: false,
      message:
        "That first game night has already passed — pick tonight or a later date.",
    };
  }
  if (weekdays.size === 0) {
    return { ok: false, message: "Pick at least one game night of the week." };
  }
  if (slotTimes.length === 0) {
    return { ok: false, message: "Enter at least one ice-time slot." };
  }

  // Alphabetical, so the same enrolment always feeds the generator in the same
  // order and a re-run is reproducible.
  const enrolledTeams = await getEnrolledTeams(seasonId, { client: admin });
  const teamIds = enrolledTeams.map((t) => t.id);
  if (teamIds.length < 2) {
    return {
      ok: false,
      message:
        "Enrol at least two teams in the season before generating a schedule.",
    };
  }
  const nameById = new Map(enrolledTeams.map((t) => [t.id, t.name]));
  // A constraint can name a team that has since been un-enrolled — that deletes
  // no team row — so this must not assume the id is in the list.
  const nameOf = (id: string) => nameById.get(id) ?? "A removed team";

  const storedConstraints = await getScheduleConstraints(seasonId, {
    client: admin,
  });

  // Resolve constraints against one calendar and refuse an impossible set before any search: named
  // contradictions first, then the counting checks.
  const checkConstraints = (
    calendar: { date: string; slots: string[] }[],
    pairings: { home: string; away: string }[],
  ) => {
    const pairingCount = pairings.length;
    // ⛔ Counted, not assumed: `buildBalancedPairings` is uneven for an odd team count, so a flat `g`
    // misstates each team's bye budget.
    const gamesPerTeam = teamIds.map(
      (id) => pairings.filter((p) => p.home === id || p.away === id).length,
    );
    const resolved = resolveConstraints(storedConstraints, {
      nights: calendar,
      teamIds,
    });
    if (resolved.items.length === 0) return { resolved, refusal: null };
    const conflicts = constraintConflicts(resolved, nameOf);
    if (conflicts.length > 0) return { resolved, refusal: conflicts.join(" ") };
    const caps = calendar.map((n) =>
      Math.min(n.slots.length, Math.floor(teamIds.length / 2)),
    );
    const perNight = distributeGames(caps, pairingCount);
    // No distribution means the calendar cannot hold the games at all, which is
    // a different failure with its own message further down. Nothing to refute.
    if (!perNight) return { resolved, refusal: null };
    const problems = refuteConstraints(resolved, {
      teamIds,
      nameOf,
      gamesPerTeam,
      gamesPerNight: perNight,
      weekOfNight: buildNightMeta(calendar).week,
    });
    return {
      resolved,
      refusal: problems.length > 0 ? problems.join(" ") : null,
    };
  };

  const perNightCap = Math.min(
    slotTimes.length,
    Math.floor(teamIds.length / 2),
  );
  let games;
  let outcomes: ReturnType<typeof assignNights>["report"]["constraints"] = [];

  if (lengthMode === "date") {
    // Fill the window to the last regular-season night, stepping games per team down from the
    // capacity estimate until every pairing fits.
    if (!regSeasonEnd) {
      return { ok: false, message: "Pick a last regular-season night." };
    }
    const nights = enumerateNights(startDate, {
      weekdays,
      slotTimes,
      excluded,
      endDate: regSeasonEnd,
    });
    if (nights.length === 0) {
      return {
        ok: false,
        message:
          "No game nights fall between those dates — check the weekdays and skip dates.",
      };
    }
    let g = Math.max(
      1,
      Math.floor((2 * nights.length * perNightCap) / teamIds.length),
    );
    // Capped, so a bad estimate cannot trigger many expensive runs; a shortfall shows the banner.
    let result: ReturnType<typeof assignNights> | undefined;
    for (let tries = 0; tries <= 8; tries++) {
      const pairings = buildBalancedPairings(teamIds, g);
      const check = checkConstraints(nights, pairings);
      if (check.refusal) {
        // Fewer games per team is more bye budget, so step down before reporting the refusal.
        if (g > 1 && tries < 8) {
          g -= 1;
          continue;
        }
        return { ok: false, message: check.refusal };
      }
      result = assignNights(pairings, nights, teamIds, {
        constraints: check.resolved,
        seed: variation,
        // ⛔ One draw on a retry: up to 8 tries of four draws each runs minutes, past the function
        // timeout on a large league.
        ...(tries > 0 ? { variations: 1 } : {}),
      });
      if (result.report.unscheduled === 0 || g <= 1 || tries >= 8) break;
      g -= 1;
    }
    if (!result) {
      return {
        ok: false,
        message: "Couldn't place any games — nothing was changed.",
      };
    }
    games = result.games;
    outcomes = result.report.constraints;
  } else {
    // Size by target games-per-team; the last game date falls out of placement.
    if (gamesPerTeam < 1) {
      return { ok: false, message: "Games per team must be at least 1." };
    }
    const pairings = buildBalancedPairings(teamIds, gamesPerTeam);
    // Exactly the nights the games need (surplus nights only make byes), growing only if placement
    // fails, never past the season end.
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
      if (nights.length === 0) {
        return {
          ok: false,
          message:
            "No game nights fall in the season — check the weekdays and skip dates.",
        };
      }
      if (nights.length === prevCount) break; // capped by season end; more won't help
      prevCount = nights.length;
      const check = checkConstraints(nights, pairings);
      // Returned, not retried with more nights: the manager asked for this many games on this calendar.
      if (check.refusal) return { ok: false, message: check.refusal };
      result = assignNights(pairings, nights, teamIds, {
        constraints: check.resolved,
        seed: variation,
        // ⛔ One draw once this loop has widened the calendar — same reasoning
        // as the `date` branch above.
        ...(extra > 0 ? { variations: 1 } : {}),
      });
      if (result.report.unscheduled === 0) break;
    }
    // Unreachable while the loop runs at least once, which it does — kept so a
    // future change to the bounds can't produce silence.
    if (!result) {
      return {
        ok: false,
        message: "Couldn't place any games — nothing was changed.",
      };
    }
    games = result.games;
    outcomes = result.report.constraints;
  }

  // What the season shows now, read before the delete, so an identical variation says so. Epoch
  // millis: Postgres normalises `scheduled_at`'s offset, so strings would always differ.
  const { data: priorDraft } = await admin
    .from("games")
    .select("home_team_id, away_team_id, scheduled_at")
    .eq("season_id", seasonId)
    .eq("is_draft", true);
  const keyOfPrior = (priorDraft ?? [])
    .map(
      (g) =>
        `${g.home_team_id}|${g.away_team_id}|${Date.parse(g.scheduled_at as string)}`,
    )
    .sort()
    .join("\n");
  const keyOfNew = games
    .map(
      (g) =>
        `${g.home}|${g.away}|${Date.parse(`${g.scheduledAt}${leagueOffset(g.scheduledAt)}`)}`,
    )
    .sort()
    .join("\n");
  const unchanged =
    priorDraft != null &&
    priorDraft.length > 0 &&
    priorDraft.length === games.length &&
    keyOfPrior === keyOfNew;

  // Replace existing drafts. Both writes are checked: the admin client returns errors rather than
  // throwing, and each failure leaves the season in a different state.
  const { error: deleteError } = await admin
    .from("games")
    .delete()
    .eq("season_id", seasonId)
    .eq("is_draft", true);
  if (deleteError) {
    // Nothing was written. Whatever draft the season already had is intact, so
    // there is nothing to revalidate — the page is still correct.
    return {
      ok: false,
      message: `Couldn't clear the previous draft, so nothing was changed. ${deleteError.message}`,
    };
  }

  if (games.length) {
    const { error: insertError } = await admin.from("games").insert(
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
    if (insertError) {
      // The delete committed, so the old draft is gone: revalidate, or the page shows a draft that
      // no longer exists.
      revalidatePath("/[league]/seasons/[seasonId]", "page");
      return {
        ok: false,
        message: `The previous draft was cleared but the new one couldn't be saved. ${insertError.message}`,
      };
    }
  }

  // ⛔ `game_nights` is written here, where the weekdays are chosen, on generate, not publish. Never
  // derive it from games: one rescheduled Saturday would make a Saturday league.
  const { error: nightsError } = await admin
    .from("seasons")
    .update({ game_nights: [...weekdays].sort((a, b) => a - b) })
    .eq("id", seasonId);
  if (nightsError) {
    console.error("season game_nights update failed:", nightsError.message);
  }

  revalidatePath("/[league]/seasons/[seasonId]", "page");

  // Placing nothing is not an error, but reporting success would misdescribe the page.
  if (games.length === 0) {
    return {
      ok: false,
      message:
        "No games could be scheduled — try more game nights or fewer games per team.",
    };
  }
  // Unmet requests are stated here; the preview lists them with reasons.
  const unmet = outcomes.filter((c) => !c.satisfied);
  if (unmet.length > 0) {
    return {
      ok: true,
      message: `Generated a ${games.length}-game draft schedule. ${unmet.length} of ${outcomes.length} manager request${outcomes.length === 1 ? "" : "s"} couldn't be met — see the preview below.`,
    };
  }
  // Said plainly: this calendar has one arrangement, and the next move is changing the calendar.
  if (unchanged && variation > 1) {
    return {
      ok: true,
      message:
        "That's the same schedule again — this season has only one arrangement that meets every goal. Changing the ice times, the game nights or the games per team is what opens up alternatives.",
    };
  }
  return {
    ok: true,
    message: `Generated a ${games.length}-game draft schedule.`,
  };
}

export type PublishState = { ok: boolean; message: string } | null;

// Refusals revalidate too: a refusal means this tab is stale, and without it the manager keeps a
// dead draft under a button that will fail again.
function revalidateAfterPublish() {
  revalidatePath("/[league]/seasons/[seasonId]", "page");
  revalidatePath("/[league]/schedule", "page");
  // The scoring list reads through getSchedule, so a replace changes which games it shows.
  revalidatePath("/[league]/schedule", "page");
  revalidatePath("/[league]", "page");
}

// A draft made with a good date can age past it; publish refuses it until `stale_ok` confirms. ⛔
// `"unreadable"` is its own answer: publishing is a one-way door, and a failed read is not "not stale".
async function staleDraftFor(
  admin: Admin,
  seasonId: string,
): Promise<StaleDraft | null | "unreadable"> {
  const { rows, error } = await readDraftGames(admin, seasonId);
  if (error) {
    console.error("draft date read failed:", error);
    return "unreadable";
  }
  return staleDraft({ games: startsOf(rows), now: new Date().toISOString() });
}

// ⛔ Retried once, like `getPublishState`: a Kong 502 is a valid response nothing below retries,
// and this read fails closed on publish.
async function readDraftGames(admin: Admin, seasonId: string) {
  const { data, error } = await readWithOneRetry(
    () =>
      admin
        .from("games")
        .select("id, scheduled_at")
        .eq("season_id", seasonId)
        .eq("is_draft", true)
        .order("scheduled_at", { ascending: true }),
    "draft dates read",
  );
  return { rows: data ?? [], error: error?.message ?? null };
}

/** The games that carry a time. An undated row has no start to compare. */
const startsOf = (rows: { scheduled_at: string | null }[]): string[] =>
  rows.flatMap((g) => (g.scheduled_at ? [g.scheduled_at] : []));

// The delete and promotion commit together inside `replace_published_schedule`: as two calls, a
// failure between them leaves the season with no games. Stale-page refusals return a message.
export async function publishSchedule(
  _prev: PublishState,
  formData: FormData,
): Promise<PublishState> {
  const admin = createAdminClient();
  const target = await targetSeasonForManager(
    admin,
    String(formData.get("season_id") ?? ""),
  );
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId, manager: user } = target;

  // ⛔ A stale draft needs `stale_ok` naming the first night the manager was warned about:
  // publishing locks the season for good, and a tab warned about another night is refused again.
  const stale = await staleDraftFor(admin, seasonId);
  if (stale === "unreadable") {
    return {
      ok: false,
      message:
        "Couldn't check the draft's dates, so nothing was published. Reload and try again.",
    };
  }
  if (stale && String(formData.get("stale_ok") ?? "") !== stale.firstNight) {
    revalidateAfterPublish();
    return {
      ok: false,
      message: `This draft's first game night (${formatLongDate(
        stale.firstNight,
      )}) has already passed — publishing it would start the season in the past and lock it for good. Reload the builder to move the draft forward, or confirm from there.`,
    };
  }

  const { data, error } = await admin.rpc("replace_published_schedule", {
    p_season: seasonId,
  });
  if (error) return { ok: false, message: error.message };

  const row = data?.[0];
  if (!row) return { ok: false, message: "Nothing happened — try again." };

  if (row.refused === "started") {
    revalidateAfterPublish();
    return {
      ok: false,
      message:
        "The season is under way — the schedule can no longer be replaced.",
    };
  }
  if (row.refused === "no_draft") {
    revalidateAfterPublish();
    return { ok: false, message: "There's no draft to publish." };
  }

  // ⛔ Publishing clears this season's requests, as the user asked; new ones may still be added. A
  // scoped, audited, awaited delete, never a truncate: other managers' rows are in it.
  const { data: cleared, error: clearError } = await admin
    .from("season_schedule_constraints")
    .delete()
    .eq("season_id", seasonId)
    .select("id, team_id, kind, params");
  // Reported, not fatal: the publish has committed, and failing here would say it had not.
  if (clearError) {
    console.error("clearing schedule constraints failed:", clearError.message);
  }
  if (cleared && cleared.length > 0) {
    await logAudit({
      user_id: user.id,
      action: "clear_schedule_constraints",
      entity_type: "season",
      entity_id: seasonId,
      old_data: { count: cleared.length, constraints: cleared },
      new_data: { count: 0 },
    });
  }

  // ⛔ Audit a stale publish: it locks the season against explicit advice, and a first publish
  // deletes nothing, so `replace_schedule` never records it.
  if (stale) {
    await logAudit({
      user_id: user.id,
      action: "publish_stale_schedule",
      entity_type: "season",
      entity_id: seasonId,
      old_data: {
        first_night: stale.firstNight,
        passed_nights: stale.passedNights,
      },
      new_data: { published_games: row.published },
    });
  }

  // A replace deletes live games, the most destructive act here; a first publish deletes nothing
  // and stays unaudited.
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

  revalidateAfterPublish();

  return {
    ok: true,
    message:
      row.deleted > 0
        ? `Replaced the published schedule — removed ${row.deleted} games, published ${row.published}.`
        : `Published ${row.published} games.`,
  };
}

export type RedateDraftState = { ok: boolean; message: string } | null;

// ⛔ Whole weeks only, so every weekday, ice time and gap survives. ⚠️ Excluded dates are not
// stored, so a shifted night can land on one; the builder lists the shifted dates for that reason.
export async function redateDraftSchedule(
  _prev: RedateDraftState,
  formData: FormData,
): Promise<RedateDraftState> {
  const admin = createAdminClient();
  const target = await targetSeasonForManager(
    admin,
    String(formData.get("season_id") ?? ""),
  );
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId, manager } = target;

  // A started season can never publish this draft: the same fail-closed gate as generate.
  const { data: startedGuard, error: startedError } = await admin.rpc(
    "season_is_started",
    { p_season: seasonId },
  );
  if (startedError) {
    return {
      ok: false,
      message:
        "Couldn't check whether the season has started — nothing was changed.",
    };
  }
  if (startedGuard !== false) {
    return {
      ok: false,
      message: "The season is under way — its draft can no longer be moved.",
    };
  }

  // The season's end rides along on the same round trip; it never decides whether the move happens.
  const [{ rows, error }, season] = await Promise.all([
    readDraftGames(admin, seasonId),
    admin.from("seasons").select("ends_on").eq("id", seasonId).maybeSingle(),
  ]);
  if (error) {
    console.error("draft read failed:", error);
    return {
      ok: false,
      message:
        "Couldn't read the draft, so nothing was moved. Reload and try again.",
    };
  }
  if (rows.length === 0) {
    return { ok: false, message: "There's no draft to move." };
  }

  const stale = staleDraft({
    games: startsOf(rows),
    now: new Date().toISOString(),
  });
  // Re-derived, not taken from the form: a second click on a draft another tab moved must do
  // nothing, not shift it another week.
  if (!stale) {
    return {
      ok: false,
      message:
        "This draft's first game hasn't been played over — nothing to move.",
    };
  }

  // ⛔ Refused here, after the staleness check, in the manager's terms rather than `checkWrites`'s
  // batch limit. ⚠️ Never chunked: a half-moved season is worse than a refusal.
  if (rows.length > MAX_GAME_WRITES) {
    return {
      ok: false,
      message: `This draft holds ${rows.length} games, more than the ${MAX_GAME_WRITES} one move can rewrite at once. Discard it and generate again from a first game night that hasn't passed.`,
    };
  }

  // Night by night: `moveNightTo` keeps a wall-clock move, so 19:00 stays 19:00 across DST.
  const byNight = new Map<
    string,
    { id: string; scheduledAt: string | null }[]
  >();
  for (const g of rows) {
    if (!g.scheduled_at) continue;
    const date = leagueDateKey(g.scheduled_at);
    (byNight.get(date) ?? byNight.set(date, []).get(date)!).push({
      id: g.id,
      scheduledAt: g.scheduled_at,
    });
  }
  const moves = [...byNight.entries()].flatMap(([date, games]) =>
    moveNightTo(games, shiftDateByWeeks(date, stale.weeks)),
  );
  if (moves.length !== rows.length) {
    // A draft game with no time: unreachable (only postponing clears one), so fail closed rather
    // than move half the schedule.
    return {
      ok: false,
      message:
        "This draft has a game with no time on it — discard it and generate again.",
    };
  }

  const problem = await writeGames(
    admin,
    seasonId,
    manager.id,
    "redate_draft_schedule",
    moves.map((m) => ({
      id: m.id,
      next: { scheduled_at: m.scheduledAt },
      expectScheduledAt: m.from,
      prev: { scheduled_at: m.from },
    })),
    ["scheduled"],
    // ⛔ Draft rows only: a "replace" season also holds a live schedule, and this moves a season's dates.
    true,
  );
  if (problem) return { ok: false, message: problem };

  await logAudit({
    user_id: manager.id,
    action: "redate_draft_schedule",
    entity_type: "season",
    entity_id: seasonId,
    old_data: { first_night: stale.firstNight, games: moves.length },
    new_data: { first_night: stale.shiftedFirstNight, weeks: stale.weeks },
  });

  // A draft shows only on the builder and the setup hub until it is published.
  revalidatePath("/[league]/seasons/[seasonId]", "page");

  // ⚠️ An overrun is reported, not refused, unlike `checkNightMove` for a published night: publish
  // already allows an overrunning draft, and refusing would strand a stale one.
  if (season.error) {
    console.error("season end read failed:", season.error.message);
  }
  const lastNight = [...byNight.keys()].sort().at(-1);
  const overruns =
    !!season.data?.ends_on &&
    !!lastNight &&
    shiftDateByWeeks(lastNight, stale.weeks) > season.data.ends_on;

  return {
    ok: true,
    message:
      `Moved the draft forward ${stale.weeks} week${
        stale.weeks === 1 ? "" : "s"
      } — it now starts ${formatLongDate(stale.shiftedFirstNight)}.` +
      (overruns
        ? ` It now runs past the season's end (${formatLongDate(
            season.data!.ends_on,
          )}) — extend the season or shorten the schedule.`
        : ""),
  };
}

export type RemoveState = { ok: boolean; message: string } | null;

// Deletes a season's published schedule with nothing in its place. Stale-page refusals return a
// message and revalidate.
export async function removeSchedule(
  _prev: RemoveState,
  formData: FormData,
): Promise<RemoveState> {
  const admin = createAdminClient();
  const target = await targetSeasonForManager(
    admin,
    String(formData.get("season_id") ?? ""),
  );
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId, manager: user } = target;

  const { data, error } = await admin.rpc("remove_published_schedule", {
    p_season: seasonId,
  });
  if (error) return { ok: false, message: error.message };

  const row = data?.[0];
  if (!row) return { ok: false, message: "Nothing happened — try again." };

  if (row.refused === "started") {
    revalidateAfterPublish();
    return {
      ok: false,
      message:
        "The season is under way — the schedule can no longer be removed.",
    };
  }
  if (row.refused === "no_games") {
    revalidateAfterPublish();
    return { ok: false, message: "There's no published schedule to remove." };
  }

  // Always audited, and awaited: every removal destroys live games, and a voided write can be
  // dropped when the runtime freezes; `logAudit` swallows its own errors.
  await logAudit({
    user_id: user.id,
    action: "remove_schedule",
    entity_type: "season",
    entity_id: seasonId,
    old_data: { published_games: row.deleted },
    new_data: { published_games: 0 },
  });

  revalidateAfterPublish();

  return {
    ok: true,
    message: `Removed the published schedule — ${row.deleted} games deleted.`,
  };
}

export async function discardSchedule(formData: FormData) {
  const admin = createAdminClient();
  const target = await targetSeasonForManager(
    admin,
    String(formData.get("season_id") ?? ""),
  );
  if (!target) return;
  const { seasonId } = target;
  await admin
    .from("games")
    .delete()
    .eq("season_id", seasonId)
    .eq("is_draft", true);
  revalidatePath("/[league]/seasons/[seasonId]", "page");
}

/* ------------------------------------------------------- reschedule a night */

export type RescheduleNightState = { ok: boolean; message: string } | null;

// ⛔ An update by id, never `replace_published_schedule`: it must work on a started season and keep
// calendar subscriptions (`RUNBOOK.md` → Schedule edits and exports). Merging nights is out of scope.
export async function rescheduleNight(
  _prev: RescheduleNightState,
  formData: FormData,
): Promise<RescheduleNightState> {
  const admin = createAdminClient();
  const target = await targetSeasonForManager(
    admin,
    String(formData.get("season_id") ?? ""),
  );
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId, manager } = target;

  const from = String(formData.get("from_date") ?? "").trim();
  const to = String(formData.get("to_date") ?? "").trim();
  // Shape only. Everything about the schedule — is this a night, is it locked,
  // is the target free — is `checkNightMove`'s, below.
  if (!DATE_RE.test(from)) {
    return { ok: false, message: "Pick a night to move." };
  }
  if (!DATE_RE.test(to)) {
    return { ok: false, message: "Pick a date to move it to." };
  }

  const [nights, teams, season] = await Promise.all([
    getSeasonNights(seasonId, { client: admin }),
    getEnrolledTeams(seasonId, { client: admin }),
    admin
      .from("seasons")
      .select("starts_on, ends_on")
      .eq("id", seasonId)
      .maybeSingle(),
  ]);
  // ⛔ Fails closed: an errored read looks like a season with no bounds and silently disables the
  // range guard.
  if (season.error) {
    console.error("season bounds read failed:", season.error.message);
    return {
      ok: false,
      message:
        "Couldn't read this season's dates, so the move wasn't attempted. Reload and try again.",
    };
  }
  // ⛔ The same guard the read beside it has always had. Without it a failed nights read reaches
  // `checkNightMove` as a season with no game nights, which refuses with "that isn't a game
  // night" — fail-closed by accident, and a lie about a schedule nobody could read.
  if (nights.readFailed) {
    return {
      ok: false,
      message:
        "Couldn't read this season's schedule, so the move wasn't attempted. Reload and try again.",
    };
  }

  const nameOf = (id: string) =>
    teams.find((t) => t.id === id)?.name ?? "a removed team";

  // Re-checked here rather than trusted from the form: a stale tab's picker and a client-side `min`
  // guarantee nothing.
  const refusal = checkNightMove({
    nights: nights.nights,
    from,
    to,
    // The league's zone, not the server's — see `checkNightMove`'s note.
    today: leagueDateKey(new Date().toISOString()),
    season: {
      startsOn: season.data?.starts_on ?? null,
      endsOn: season.data?.ends_on ?? null,
    },
    nameOf,
  });
  if (refusal) return { ok: false, message: refusal };

  const source = nights.nights.find((n) => n.date === from)!;
  const moves = moveNightTo(source.games, to);
  if (moves.length !== source.games.length) {
    // ⚠️ Unreachable: only a postponed game lacks a time, and its night is locked. Fail closed rather
    // than move half a night.
    return {
      ok: false,
      message: "That night has a game with no time on it — move it on its own.",
    };
  }

  // Only `scheduled_at` is written, each held against the time read, so a game rescheduled meanwhile
  // refuses. An update by id, never an upsert (`RUNBOOK.md` → Schedule edits and exports).
  const problem = await writeGames(
    admin,
    seasonId,
    manager.id,
    "reschedule_night",
    moves.map((m) => ({
      id: m.id,
      next: { scheduled_at: m.scheduledAt },
      expectScheduledAt: m.from,
      prev: { scheduled_at: m.from },
    })),
    // Defence in depth: the rows come from a published-only read, and this keeps a future read that
    // drops the filter away from draft rows.
    ["scheduled"],
    false,
  );
  if (problem) return { ok: false, message: problem };

  await logAudit({
    user_id: manager.id,
    action: "reschedule_night",
    entity_type: "season",
    entity_id: seasonId,
    // Both sides with times: the old timestamps exist nowhere else once the rows change.
    old_data: {
      date: from,
      games: moves.map((m) => ({ id: m.id, scheduledAt: m.from })),
    },
    new_data: {
      date: to,
      games: moves.map((m) => ({ id: m.id, scheduledAt: m.scheduledAt })),
    },
  });

  // The repair page lists this season's nights and their ice times, so a moved
  // night makes its pickers stale exactly as it does the builder's.
  revalidatePath("/[league]/schedule/repair", "page");
  revalidatePath("/[league]/schedule/one-off", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
  revalidatePath("/[league]/schedule", "page");
  revalidatePath("/[league]", "page");

  return {
    ok: true,
    message: `Moved ${moves.length} game${moves.length === 1 ? "" : "s"} from ${formatLongDate(from)} to ${formatLongDate(to)}.`,
  };
}

/* ------------------------------------------------------------------ one-off */

// Never `export type { OneOffRound }` from a "use server" module: it compiles, then fails the build
// as a missing server action.

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
  nights: {
    date: string;
    times: string[];
    /** The night's game ids in slot order, for the apply-time identity check. */
    gameIds: string[];
    locked: boolean;
  }[];
  oneOffNight: number;
  relabelOnly: boolean;
  plans: OneOffPlan[];
};

export type OneOffState =
  | null
  | { ok: false; message: string }
  | { ok: true; kind: "preview"; preview: OneOffPreview }
  | { ok: true; kind: "applied"; message: string };

// Read fresh by preview and apply alike, so apply validates the schedule as it is now.
async function loadContext(seasonId: string, admin: Admin) {
  // Admin client, not RLS: the season is manager-named, and a policy gap would return an empty
  // schedule silently rather than an error.
  const [enrolled, nights] = await Promise.all([
    getEnrolledTeams(seasonId, { client: admin }),
    getSeasonNights(seasonId, { client: admin }),
  ]);
  const teams = enrolled.map((t) => ({ id: t.id, name: t.name }));
  const indexOf = new Map(teams.map((t, i) => [t.id, i]));
  // ⚠️ Carried, not swallowed: an empty night list plans a one-off into a season that looks like
  // it has no games, and every caller below must refuse rather than act on that picture.
  return {
    teams,
    indexOf,
    nights: nights.nights,
    nightsReadFailed: nights.readFailed,
  };
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

/** Plan a one-off and its repair. Reads only; `applyOneOffGame` writes. */
export async function previewOneOffGame(
  input: OneOffInput,
): Promise<OneOffState> {
  const admin = createAdminClient();
  const target = await targetSeasonForManager(admin, input.seasonId);
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId } = target;

  const { teams, indexOf, nights, nightsReadFailed } = await loadContext(
    seasonId,
    admin,
  );
  // ⛔ Fails closed WITH THE TRUE REASON, the same discipline as `moveGameNight`'s season-bounds
  // guard: an unread schedule reads as a season with no game nights, and every message below
  // would then tell the manager something false about their own season.
  if (nightsReadFailed) {
    return {
      ok: false,
      message:
        "Couldn't read this season's schedule, so nothing was attempted. Reload and try again.",
    };
  }
  const bad = readInput(input, indexOf);
  if (bad) return { ok: false, message: bad };

  const plannerNights = toPlannerNights(nights, indexOf);
  if (!plannerNights) {
    return {
      ok: false,
      message:
        "The schedule has a game for a team that isn't enrolled this season.",
    };
  }

  const oneOffNight = nights.findIndex((n) => n.date === input.date);
  if (oneOffNight < 0) {
    return { ok: false, message: "That date isn't a game night this season." };
  }

  // Stored `slot_on` pins, resolved against the season as published. A postponed game gets a
  // placeholder time, since dropping it would shift every later slot index.
  const constraintCalendar = nights.map((n) => ({
    date: n.date,
    slots: n.games.map((g) =>
      g.scheduledAt ? leagueTimeKey(g.scheduledAt) : "--:--",
    ),
  }));
  const resolvedPins = resolveConstraints(
    await getScheduleConstraints(seasonId, { client: admin }),
    { nights: constraintCalendar, teamIds: teams.map((t) => t.id) },
  );

  const result = planOneOff({
    teamCount: teams.length,
    nights: plannerNights,
    oneOffNight,
    forcedPairs: input.matchups.map(
      ([h, a]) => [indexOf.get(h)!, indexOf.get(a)!] as [number, number],
    ),
    featureSlot: input.featureSlot,
    slotPins:
      resolvedPins.slotPins.length > 0 ? resolvedPins.slotPins : undefined,
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
        // Travels back with the chosen plan and is enforced at apply — see
        // `PlannedNight.gameIds`.
        gameIds: n.games.map((g) => g.id),
        locked: n.locked,
      })),
      oneOffNight,
      relabelOnly: result.relabelOnly,
      plans: result.plans,
    },
  };
}

// Validates the plan rather than re-solving (the solvers stop on a deadline, so reruns differ), keyed
// by date, not position, so a re-dated game cannot shift the plan onto the wrong nights.
export async function applyOneOffGame(
  // `featureSlot` is deliberately absent: it steers the *planner*, and by this
  // point the chosen plan already encodes which game sits on which ice time.
  input: Omit<OneOffInput, "featureSlot"> & {
    /** ⛔ `gameIds` is required: a `rescheduleGame` between preview and apply re-sorts the night. */
    changes: { date: string; to: [number, number][]; gameIds: string[] }[];
  },
): Promise<OneOffState> {
  const admin = createAdminClient();
  const target = await targetSeasonForManager(admin, input.seasonId);
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId, manager } = target;

  const { teams, indexOf, nights, nightsReadFailed } = await loadContext(
    seasonId,
    admin,
  );
  // ⛔ Fails closed WITH THE TRUE REASON, the same discipline as `moveGameNight`'s season-bounds
  // guard: an unread schedule reads as a season with no game nights, and every message below
  // would then tell the manager something false about their own season.
  if (nightsReadFailed) {
    return {
      ok: false,
      message:
        "Couldn't read this season's schedule, so nothing was attempted. Reload and try again.",
    };
  }
  const bad = readInput(input, indexOf);
  if (bad) return { ok: false, message: bad };

  const teamIds = teams.map((t) => t.id);

  // Everything between the payload and the write: `checkOneOffWrite`, pure and tested.
  const rejected = checkOneOffWrite({
    nights: nights.map((n) => ({
      date: n.date,
      locked: n.locked,
      games: n.games.map(
        (g) => [g.homeTeamId, g.awayTeamId] as [string, string],
      ),
      gameIds: n.games.map((g) => g.id),
    })),
    teamIds,
    date: input.date,
    forcedPairs: input.matchups,
    changes: input.changes,
  });
  if (rejected) return { ok: false, message: rejected };

  // Which rows the plan writes, and what goes in them — pure, and tested in
  // oneOff.test.ts. Everything left here is the I/O either side of it.
  const rows = buildOneOffRows({
    nights,
    teamIds,
    date: input.date,
    round: input.round,
    label: input.label,
    forcedPairs: input.matchups,
    changes: input.changes,
  });

  // ⛔ An update by id, never an upsert: an upsert resurrects a deleted game as a live fixture, and
  // the time is a condition, not payload (`RUNBOOK.md` → Schedule edits and exports).
  const problem = await writeGames(
    admin,
    seasonId,
    manager.id,
    "schedule_one_off",
    rows.map((r) => ({
      id: r.id,
      next: {
        home_team_id: r.homeTeamId,
        away_team_id: r.awayTeamId,
        label: r.label,
      },
      // Non-null through a chain: these nights passed `checkOneOffWrite`, and a postponed game locks
      // its night (`RUNBOOK.md` → Schedule edits and exports → Postponing).
      expectScheduledAt: r.scheduledAt!,
      prev: {
        home_team_id: r.prevHomeTeamId,
        away_team_id: r.prevAwayTeamId,
        label: r.prevLabel,
      },
    })),
    // Defence in depth: the rows come from a published-only read, and this keeps a future read that
    // drops the filter away from draft rows.
    ["scheduled"],
    false,
  );
  if (problem) return { ok: false, message: problem };

  // Filed under the season, which `logAudit` resolves to its league — the same
  // shape as `repair_schedule`. `writeGames` audits only the failures.
  await logAudit({
    user_id: manager.id,
    action: "schedule_one_off",
    entity_type: "season",
    entity_id: seasonId,
    old_data: { nights: input.changes.map((c) => c.date) },
    new_data: {
      date: input.date,
      label: input.label,
      games_rewritten: rows.length,
    },
  });

  revalidatePath("/[league]/schedule/one-off", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
  revalidatePath("/[league]/schedule", "page");
  revalidatePath("/[league]", "page");

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

/* ------------------------------------------------------------------- repair */

export type RepairPreview = {
  /** Index-aligned with the planner's team indices. */
  teams: { id: string; name: string }[];
  /** Index-aligned with the planner's nights. ⛔ `gameIds` is checked at apply: see `PlannedNight.gameIds`. */
  nights: { date: string; gameIds: string[]; locked: boolean }[];
  plans: OneOffPlan[];
  /** Why the pin could not be honoured — shown instead of plans. */
  unmet: string | null;
  /** True when the published schedule already satisfied the pin. */
  pinAlreadyMet: boolean;
  /** True when repairs exist but every one of them would break the pin. */
  pinBlocksImprovement: boolean;
  /** True when the season is already as good as the search can make it. */
  nothingToImprove: boolean;
};

export type RepairInput = {
  seasonId: string;
  /** Pin a team to a night, optionally at an ice time. Null repairs as-is. */
  pin: { teamId: string; date: string; time: string } | null;
};

export type RepairState =
  | null
  | { ok: false; message: string }
  | { ok: true; kind: "preview"; preview: RepairPreview }
  | { ok: true; kind: "applied"; message: string };

// ⚠️ From the season as published, never a form's `slot_times`: the pin is about a night that
// already has ice times. A postponed game's placeholder keeps later slot indexes aligned.
function publishedSlots(nights: SeasonNight[]) {
  return nights.map((n) => ({
    date: n.date,
    slots: n.games.map((g) =>
      g.scheduledAt ? leagueTimeKey(g.scheduledAt) : "--:--",
    ),
  }));
}

/** Everything the planner needs, or a message saying why it can't be had. */
async function repairContext(seasonId: string, admin: Admin) {
  const { teams, indexOf, nights, nightsReadFailed } = await loadContext(
    seasonId,
    admin,
  );
  // ⛔ Fails closed WITH THE TRUE REASON, the same discipline as `moveGameNight`'s season-bounds
  // guard: an unread schedule reads as a season with no game nights, and every message below
  // would then tell the manager something false about their own season.
  if (nightsReadFailed) {
    return {
      ok: false as const,
      message:
        "Couldn't read this season's schedule, so nothing was attempted. Reload and try again.",
    };
  }
  if (nights.length === 0) {
    return {
      ok: false as const,
      message: "This season has no published schedule to repair.",
    };
  }
  const plannerNights = toPlannerNights(nights, indexOf);
  if (!plannerNights) {
    return {
      ok: false as const,
      message:
        "The schedule has a game for a team that isn't enrolled this season.",
    };
  }
  // ⛔ Stored pins are read here: requests can be added after publish, and `previewOneOffGame`
  // reads the same rows, so the two planners must agree.
  const resolved = resolveConstraints(
    await getScheduleConstraints(seasonId, { client: admin }),
    { nights: publishedSlots(nights), teamIds: teams.map((t) => t.id) },
  );
  return {
    ok: true as const,
    teams,
    indexOf,
    nights,
    plannerNights,
    resolved,
  };
}

// ⛔ The time must be one of the night's published ice times, refused rather than rounded: a quietly
// relocated pin is invisible to the manager.
function readRepairPin(
  pin: NonNullable<RepairInput["pin"]>,
  nights: SeasonNight[],
  indexOf: Map<string, number>,
): { pin: RepairPin } | { error: string } {
  const team = indexOf.get(pin.teamId);
  if (team === undefined) {
    return { error: "Pick a team enrolled in this season." };
  }
  const night = nights.findIndex((n) => n.date === pin.date);
  if (night < 0) return { error: "That date isn't a game night this season." };

  if (!pin.time) return { pin: { kind: "play_on", team, night } };

  const wanted = normalizeTime(pin.time);
  if (!wanted) return { error: "Enter the ice time as HH:MM." };
  const slot = publishedSlots(nights)[night].slots.indexOf(wanted);
  if (slot < 0)
    return { error: `${wanted} isn't one of that night's ice times.` };
  return { pin: { kind: "slot_on", team, night, slot } };
}

// Plans a repair, with or without a pin; reads only. ⛔ Never `generateSchedule` or
// `replace_published_schedule`: both refuse a started season, which is what this is for.
export async function previewScheduleRepair(
  input: RepairInput,
): Promise<RepairState> {
  const admin = createAdminClient();
  const target = await targetSeasonForManager(admin, input.seasonId);
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId } = target;

  const ctx = await repairContext(seasonId, admin);
  if (!ctx.ok) return { ok: false, message: ctx.message };
  const { teams, indexOf, nights, plannerNights, resolved } = ctx;

  let pin: RepairPin | null = null;
  if (input.pin) {
    const read = readRepairPin(input.pin, nights, indexOf);
    if ("error" in read) return { ok: false, message: read.error };
    pin = read.pin;
  }

  const result = planRepair({
    teamCount: teams.length,
    nights: plannerNights,
    // Stored `slot_on` requests, honoured as the one-off planner does: preserve a game on its ice
    // time, never drag one back. The pin outranks them on its own night.
    slotPins: resolved.slotPins.length > 0 ? resolved.slotPins : undefined,
    pin,
  });
  if (!result.ok) return { ok: false, message: result.reason };

  return {
    ok: true,
    kind: "preview",
    preview: {
      teams,
      nights: nights.map((n) => ({
        date: n.date,
        gameIds: n.games.map((g) => g.id),
        locked: n.locked,
      })),
      plans: result.plans,
      unmet: result.unmet,
      pinAlreadyMet: result.pinAlreadyMet,
      pinBlocksImprovement: result.pinBlocksImprovement ?? false,
      nothingToImprove: result.nothingToImprove,
    },
  };
}

// ⛔ An update by id, never an upsert, so no game gets a new id or loses its calendar subscription.
// Validated, not re-solved, and keyed by date, as in `applyOneOffGame` (`RUNBOOK.md` → Schedule edits and exports).
export async function applyScheduleRepair(input: {
  seasonId: string;
  changes: { date: string; to: [number, number][]; gameIds: string[] }[];
}): Promise<RepairState> {
  const admin = createAdminClient();
  const target = await targetSeasonForManager(admin, input.seasonId);
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId, manager } = target;

  if (input.changes.length === 0) {
    return { ok: false, message: "That plan changes nothing." };
  }

  const { teams, nights, nightsReadFailed } = await loadContext(seasonId, admin);
  // ⛔ Fails closed WITH THE TRUE REASON, the same discipline as `moveGameNight`'s season-bounds
  // guard: an unread schedule reads as a season with no game nights, and every message below
  // would then tell the manager something false about their own season.
  if (nightsReadFailed) {
    return {
      ok: false,
      message:
        "Couldn't read this season's schedule, so nothing was attempted. Reload and try again.",
    };
  }
  const teamIds = teams.map((t) => t.id);

  const rejected = checkOneOffWrite({
    nights: nights.map((n) => ({
      date: n.date,
      locked: n.locked,
      games: n.games.map(
        (g) => [g.homeTeamId, g.awayTeamId] as [string, string],
      ),
      gameIds: n.games.map((g) => g.id),
    })),
    teamIds,
    // No labelled game on this path — see `CheckWriteOptions.date`.
    date: null,
    forcedPairs: [],
    changes: input.changes,
  });
  if (rejected) return { ok: false, message: rejected };

  const rows = buildOneOffRows({
    nights,
    teamIds,
    date: null,
    round: "final",
    label: "",
    forcedPairs: [],
    changes: input.changes,
  });

  if (rows.length === 0) {
    return { ok: false, message: "That plan changes nothing." };
  }

  // ⛔ `scheduled_at` is the condition, never written: writing it back "unchanged" silently undoes a
  // `rescheduleGame` that lands between preview and apply.
  const problem = await writeGames(
    admin,
    seasonId,
    manager.id,
    "repair_schedule",
    rows.map((r) => ({
      id: r.id,
      next: {
        home_team_id: r.homeTeamId,
        away_team_id: r.awayTeamId,
        label: r.label,
      },
      // Non-null through a chain: these nights passed `checkOneOffWrite`, and a postponed game locks
      // its night (`RUNBOOK.md` → Schedule edits and exports → Postponing).
      expectScheduledAt: r.scheduledAt!,
      prev: {
        home_team_id: r.prevHomeTeamId,
        away_team_id: r.prevAwayTeamId,
        label: r.prevLabel,
      },
    })),
    // Defence in depth: the rows come from a published-only read, and this keeps a future read that
    // drops the filter away from draft rows.
    ["scheduled"],
    false,
  );
  if (problem) return { ok: false, message: problem };

  await logAudit({
    user_id: manager.id,
    action: "repair_schedule",
    entity_type: "season",
    entity_id: seasonId,
    old_data: { nights: input.changes.map((c) => c.date) },
    new_data: { games_rewritten: rows.length },
  });

  revalidatePath("/[league]/schedule/repair", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
  revalidatePath("/[league]/schedule", "page");
  revalidatePath("/[league]", "page");

  const n = input.changes.length;
  return {
    ok: true,
    kind: "applied",
    message: `Repaired ${n} night${n === 1 ? "" : "s"} — ${rows.length} game${rows.length === 1 ? "" : "s"} rewritten in place, keeping their ids and ice times.`,
  };
}

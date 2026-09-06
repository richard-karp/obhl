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
  type SeasonNight,
} from "@/lib/queries/schedule";
import { checkNightMove, moveNightTo } from "@/lib/schedule/nights";
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
import type { TablesInsert } from "@/lib/db/helpers";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The season to operate on: an explicit `season_id` from the form (validated to
 * the current league — used by the per-season setup hub), else the active season
 * (used by the standalone /schedule-builder).
 *
 * A season that doesn't resolve returns null rather than falling back to
 * whichever season happened to be active. Every action here replaces or repairs
 * a published schedule, so the cost of guessing is a season losing its games —
 * refusing is the only safe reading of "I asked for A and A isn't here".
 *
 * There used to be a second guard here, `.eq("league_id", <current league>)`,
 * and a fallback to that league's active season. Both existed because the league
 * came from the global `obhl_league` cookie: switching league in a second tab
 * made the first tab's `/seasons/<A>` form resolve against league B. The league
 * is in the URL now, so there is no ambient league left for a form's season id
 * to disagree with, and every caller names its season explicitly — the form is
 * only ever rendered by a league-scoped page, and `seasons/[seasonId]` 404s a
 * season belonging to another league before the form is drawn.
 */
async function targetSeason(admin: Admin, explicit = "") {
  if (!explicit) return null;

  const { data } = await admin
    .from("seasons")
    .select("id")
    .eq("id", explicit)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * `targetSeason`, then the guard the season implies.
 *
 * Every action in this file replaces or repairs a published schedule, and the
 * form carries a season id with no league beside it. Resolving the league from
 * the season and checking membership is what stops a manager of one league
 * regenerating another league's schedule from a hand-made request — the season
 * lookup on its own only proves the id exists somewhere.
 */
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
  // The shape check above admits "99:99", which would be stored happily and
  // then never match a slot. Since `55947c2` that surfaces as "99:99 is not an
  // ice time on <date>" rather than silence, so this is no longer a hidden
  // failure — it refuses at the point the manager can still fix it, which is
  // the better place. (`DATE_RE` above has the same shape-only gap and accepts
  // "2026-13-45"; that one surfaces as "not a game night".)
  if (Number(h) > 23 || Number(m) > 59) return null;
  return `${h.padStart(2, "0")}:${m}`;
}

/**
 * Read the params for one constraint kind off the form, or say what is missing.
 *
 * Stores what the manager MEANT — a date, a week-of date, a wall-clock ice time
 * — and never a week number or a slot position. See `0039`'s header for why.
 */
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

/**
 * Add one manager constraint to a season.
 *
 * Deliberately NOT validated against a calendar here. The season's game nights
 * do not exist until the generate form is filled in — they are derived by
 * `enumerateNights` from the weekdays, skip dates and start/end on screen, and
 * nothing is stored. So a date is accepted as written and checked at generation,
 * where a calendar exists; a request naming a date that turns out not to be a
 * game night is reported unmet with that reason rather than refused here on a
 * calendar this action cannot see.
 */
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
  // Enrolment, not merely existence: a constraint naming a team from another
  // season is meaningless to the generator, which only ever sees this season's
  // team list.
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
  revalidatePath("/[league]/schedule-builder", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
  return {
    ok: true,
    message: `Added: ${describeConstraint({ kind, params: read.params }, team.name)}.`,
  };
}

/** Remove one manager constraint. */
export async function deleteScheduleConstraint(
  _prev: ConstraintState,
  formData: FormData,
): Promise<ConstraintState> {
  const admin = createAdminClient();
  const constraintId = String(formData.get("constraint_id") ?? "");
  if (!constraintId) return { ok: false, message: "No request selected." };

  // Read the row BEFORE deleting it: the guard needs its season, and once the
  // row is gone `leagueOfEntity` has nothing to resolve from, so the audit entry
  // would file under a null league and be invisible to every league-scoped view.
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
  revalidatePath("/[league]/schedule-builder", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
  return { ok: true, message: "Removed that request." };
}

export type GenerateState = { ok: boolean; message: string } | null;

/**
 * Generate a balanced draft schedule (replaces any existing drafts). The regular
 * season starts at the season's start date and is sized either by a target
 * games-per-team or by an explicit last regular-season night — the season's own
 * end date is the playoff-inclusive boundary and only bounds/warns, it doesn't
 * size the schedule.
 *
 * Every refusal returns a specific message. This used to return `void` and bail
 * silently on nine different conditions, which was invisible on a form whose
 * successful run takes ~26 seconds: an unchecked weekday and a slow generate
 * looked exactly alike.
 */
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
  // Recurring weeknights the league plays (0=Sun..6=Sat) — one or more.
  const weekdays = new Set(formData.getAll("weekdays").map((d) => Number(d)));
  // Dates to skip (weeks off / holidays).
  const excluded = new Set(
    String(formData.get("excluded_dates") ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // ⛔ NORMALISED, and it has to be, because a `slot_on` constraint is matched
  // against these by STRING EQUALITY (`nights[n].slots.indexOf(time)`).
  // `saveScheduleConstraint` zero-pads what the manager picked, so a season
  // whose ice times were typed "9:00, 20:15" — this is a free-text field —
  // could never match a stored "09:00", and every pin at that time was reported
  // as "09:00 is not an ice time on <date>": a time the manager never typed,
  // about a slot that is plainly there. Normalising both sides is the fix; only
  // this side was doing it.
  const slotTimes = String(formData.get("slot_times") ?? "19:00,20:15,21:30")
    .split(",")
    .map((s) => s.trim())
    // Unparseable entries pass through untouched rather than being dropped:
    // this field is the season's ice times, and silently losing one would
    // change how many games a night can hold.
    .map((s) => normalizeTime(s) ?? s)
    .filter(Boolean);
  if (!startDate) return { ok: false, message: "Pick a first game night." };
  // ⛔ The one irreversible mistake the builder offers. A past-dated DRAFT is
  // invisible to `season_is_started` (it counts only `not is_draft`), so this
  // looks fine right up until publish — which locks the season for good.
  // Refused here rather than at publish, so the manager finds out before they
  // have a draft they have reviewed and can do nothing with.
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

  /**
   * Resolve the season's constraints against one concrete calendar, and refuse
   * an impossible set on arithmetic before any search runs.
   *
   * Direct contradictions first — `bye_on` and `play_on` for one team and date,
   * or two teams pinned to one ice time — because they are the likeliest thing a
   * manager actually does wrong and they deserve a message naming both offending
   * requests rather than a generic "infeasible". Only then the counting checks,
   * which are the same class as `solveParticipation`'s own pre-checks and cost
   * microseconds against a search that would otherwise run its budget out and
   * report nothing useful.
   */
  const checkConstraints = (
    calendar: { date: string; slots: string[] }[],
    pairings: { home: string; away: string }[],
  ) => {
    const pairingCount = pairings.length;
    // ⛔ COUNTED, NOT ASSUMED. `buildBalancedPairings(teams, g)` is not uniform
    // for an odd team count — measured `T=7, g=8` → [8,9,9,8,9,8,9] — so
    // filling this vector with the requested `g` overstates the bye budget for
    // the teams that draw the extra game (a refutation that should fire and
    // does not, falling through to a misleading planner message) and
    // understates it in the `play_on` count check (a refusal that should not).
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
    // Fill the window up to the last regular-season night. Derive games-per-team
    // by placement: start from the capacity estimate and step down until every
    // pairing fits (so the draft is never reported as incomplete).
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
    // The estimate is an upper bound; step down until everything fits. Capped so
    // a bad estimate can't trigger many expensive placement runs — a remaining
    // shortfall just surfaces the "incomplete" banner.
    let result: ReturnType<typeof assignNights> | undefined;
    for (let tries = 0; tries <= 8; tries++) {
      const pairings = buildBalancedPairings(teamIds, g);
      const check = checkConstraints(nights, pairings);
      if (check.refusal) {
        // Fewer games per team is more bye budget, so stepping down can clear an
        // arithmetic refusal outright — the same step this loop already takes
        // for a placement shortfall. Only report it once there is nowhere left
        // to step to.
        if (g > 1 && tries < 8) {
          g -= 1;
          continue;
        }
        return { ok: false, message: check.refusal };
      }
      result = assignNights(pairings, nights, teamIds, {
        constraints: check.resolved,
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
      // Returned rather than retried with more nights: the manager asked for
      // this many games over this calendar, and the refusal says exactly which
      // request will not fit it.
      if (check.refusal) return { ok: false, message: check.refusal };
      result = assignNights(pairings, nights, teamIds, {
        constraints: check.resolved,
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

  // Replace existing drafts.
  //
  // Both writes are checked. The admin client sets no `throwOnError`, so a
  // failure comes back in `error` rather than as an exception — and now that
  // this action reports its outcome out loud, an unchecked failure would not
  // just be silent, it would be a positive claim that a draft exists when none
  // does. The two failures also leave the season in different states, so they
  // say different things.
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
      // The delete has already committed, so the old draft is gone and nothing
      // replaced it. Revalidate before returning: the page is showing a draft
      // that no longer exists, and a message alone would leave it there.
      revalidatePath("/[league]/schedule-builder", "page");
      revalidatePath("/[league]/seasons/[seasonId]", "page");
      return {
        ok: false,
        message: `The previous draft was cleared but the new one couldn't be saved. ${insertError.message}`,
      };
    }
  }
  revalidatePath("/[league]/schedule-builder", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");

  // A run that places nothing isn't an error — it deleted the old drafts and
  // wrote a valid empty result — but reporting it as a success would be a lie
  // about what the manager is now looking at.
  if (games.length === 0) {
    return {
      ok: false,
      message:
        "No games could be scheduled — try more game nights or fewer games per team.",
    };
  }
  // Unmet constraints are stated on the way out, not left to be noticed. The
  // preview below the form lists them individually with their reasons; this is
  // the sentence that sends the manager to look.
  const unmet = outcomes.filter((c) => !c.satisfied);
  if (unmet.length > 0) {
    return {
      ok: true,
      message: `Generated a ${games.length}-game draft schedule. ${unmet.length} of ${outcomes.length} manager request${outcomes.length === 1 ? "" : "s"} couldn't be met — see the preview below.`,
    };
  }
  return {
    ok: true,
    message: `Generated a ${games.length}-game draft schedule.`,
  };
}

export type PublishState = { ok: boolean; message: string } | null;

/**
 * Every path whose view of a season's games a publish or replace can change.
 *
 * Refusals revalidate too. A refusal *means* this tab is stale — the season
 * started, or the draft was discarded in another tab — so returning the message
 * without this leaves the manager looking at the draft that no longer exists,
 * under a button that will fail the same way again.
 */
function revalidateAfterPublish() {
  revalidatePath("/[league]/schedule-builder", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
  revalidatePath("/[league]/schedule", "page");
  // The scoring list reads through getSchedule, so a replace changes which games
  // it shows. The old publishSchedule didn't revalidate it either — that gap was
  // invisible while publishing only ever added games.
  revalidatePath("/[league]/schedule", "page");
  revalidatePath("/[league]", "page");
}

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
  const admin = createAdminClient();
  const target = await targetSeasonForManager(
    admin,
    String(formData.get("season_id") ?? ""),
  );
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId, manager: user } = target;

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

  // ⛔ PUBLISH IS TERMINAL, SO THE SEASON'S MANAGER REQUESTS GO WITH IT.
  //
  // They are instructions to the *generator*, and after a publish there is
  // nothing left for the generator to do on this season — `season_is_started`
  // shuts generate and replace the moment the first game is played. Leaving them
  // behind means the next season's setup starts under last season's requests,
  // which is how a forced bye outlives the reason it was asked for.
  //
  // ⚠️ These are shared rows: another manager may have added one. So this is a
  // scoped delete of THIS season's rows, audited with the count and the rows
  // themselves — never a truncate, and never silent. Awaited for the same reason
  // `removeSchedule`'s audit is: a `void` promise can be dropped when the
  // runtime freezes the function after the response, and this is the record of
  // rows nobody else can reconstruct. `logAudit` swallows its own errors, so
  // awaiting cannot turn a successful publish into a reported failure.
  const { data: cleared, error: clearError } = await admin
    .from("season_schedule_constraints")
    .delete()
    .eq("season_id", seasonId)
    .select("id, team_id, kind, params");
  // Reported, not fatal. The publish itself has already committed, so failing
  // the whole action here would tell the manager their schedule did not go live
  // when it did.
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

  revalidateAfterPublish();

  return {
    ok: true,
    message:
      row.deleted > 0
        ? `Replaced the published schedule — removed ${row.deleted} games, published ${row.published}.`
        : `Published ${row.published} games.`,
  };
}

export type RemoveState = { ok: boolean; message: string } | null;

/**
 * Delete a season's published schedule, leaving it with no games.
 *
 * The counterpart to `publishSchedule` rather than a variant of it: replacing
 * needs a draft standing ready, and this exists for the case where there is
 * nothing to put in the old schedule's place.
 *
 * Refusals are ordinary outcomes of a stale page, not faults: the season may
 * have started since the tab was opened, or another tab may already have
 * removed the schedule. Both come back as a message, and both revalidate — a
 * refusal means this tab's view is already wrong.
 */
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

  // Audited unconditionally. publishSchedule exempts a first publish because it
  // destroys nothing; every successful removal destroys live games, so there is
  // no equivalent cheap case here.
  //
  // Awaited, unlike the rest of the app's audit calls. A `void` promise can be
  // left unfinished when the runtime freezes the function after the response,
  // and this is the one audit record whose loss would leave a season's schedule
  // gone with nothing saying who removed it. logAudit swallows its own errors
  // (src/lib/audit.ts), so awaiting cannot turn a successful removal into a
  // reported failure — it only costs one insert's latency.
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

/** Discard all draft games for the season. */
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
  revalidatePath("/[league]/schedule-builder", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
}

/* ------------------------------------------------------- reschedule a night */

export type RescheduleNightState = { ok: boolean; message: string } | null;

/**
 * Move every game on one night to another date.
 *
 * ⛔ AN IN-PLACE UPDATE BY ID, NEVER `replace_published_schedule`. This exists
 * to be usable on a season already being played — `season_is_started` shuts
 * generate, replace and remove permanently once the first game is in the past —
 * so it takes the same write path `applyOneOffGame` does: an ordinary
 * authenticated update of the rows that move, with their ids untouched, which is
 * what keeps the teams' calendar subscriptions pointing at the same events.
 *
 * Three refusals, each saying its own thing:
 *
 *  - **A locked source night**, and it names the game that locked it. Moving the
 *    unplayed remainder of a night somebody has already started scoring would
 *    split a night in two silently, which is worse than not moving it.
 *  - **A non-empty target night.** ⚠️ Merging two nights is out of scope on
 *    purpose: it changes how many games run in an evening, which is an
 *    ice-booking question this app cannot answer. The refusal names the count so
 *    the manager can see what is in the way.
 *  - **A date that is not a game night**, which is the stale-tab case.
 *
 * Participation is untouched — the same teams play the same opponents, only the
 * calendar date moves — so nothing here needs the repair engine.
 */
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

  const [nights, teams] = await Promise.all([
    getSeasonNights(seasonId, { client: admin }),
    getEnrolledTeams(seasonId, { client: admin }),
  ]);
  const nameOf = (id: string) =>
    teams.find((t) => t.id === id)?.name ?? "a removed team";

  // Every refusal, in one pure and separately tested place — see
  // `checkNightMove`. Re-read here rather than trusted from the form: the
  // picker only offers unlocked nights, but a stale tab's option list is not a
  // guarantee about the schedule as it is now.
  const refusal = checkNightMove({ nights, from, to, nameOf });
  if (refusal) return { ok: false, message: refusal };

  const source = nights.find((n) => n.date === from)!;
  const moves = moveNightTo(source.games, to);
  if (moves.length !== source.games.length) {
    // Only a game with no date of its own can be dropped, and its night would
    // have been locked. Fail closed rather than move the half that has one.
    return {
      ok: false,
      message: "That night has a game with no time on it — move it on its own.",
    };
  }

  // One statement per row rather than an upsert: these rows exist, and an
  // `upsert` would silently INSERT a dateless game if one were deleted between
  // the read and the write. `.eq("season_id")` keeps a stale id from another
  // season out of the update even though the ids came from this season's read.
  for (const m of moves) {
    const { error } = await admin
      .from("games")
      .update({ scheduled_at: m.scheduledAt })
      .eq("id", m.id)
      .eq("season_id", seasonId);
    if (error) return { ok: false, message: error.message };
  }

  await logAudit({
    user_id: manager.id,
    action: "reschedule_night",
    entity_type: "season",
    entity_id: seasonId,
    old_data: { date: from, games: source.games.map((g) => g.id) },
    new_data: { date: to, games: moves },
  });

  revalidatePath("/[league]/schedule-builder", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
  revalidatePath("/[league]/schedule", "page");
  revalidatePath("/[league]", "page");

  return {
    ok: true,
    message: `Moved ${moves.length} game${moves.length === 1 ? "" : "s"} from ${formatLongDate(from)} to ${formatLongDate(to)}.`,
  };
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
  const admin = createAdminClient();
  const target = await targetSeasonForManager(admin, input.seasonId);
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId } = target;

  const { teams, indexOf, nights } = await loadContext(seasonId, admin);
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

  // The manager's `slot_on` pins, resolved against the season AS PUBLISHED —
  // see `PlanOneOffOptions.slotPins` for what the repair does with them and why
  // it ignores the bye and play kinds. A postponed game has no time of its own,
  // so it gets a placeholder that no stored ice time can equal; dropping it
  // instead would shift every later slot index on that night.
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
  const admin = createAdminClient();
  const target = await targetSeasonForManager(admin, input.seasonId);
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId } = target;

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
      games: n.games.map(
        (g) => [g.homeTeamId, g.awayTeamId] as [string, string],
      ),
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
    const { error } = await admin
      .from("games")
      .upsert(rows, { onConflict: "id" });
    if (error) return { ok: false, message: error.message };
  }

  revalidatePath("/[league]/schedule-builder", "page");
  revalidatePath("/[league]/schedule-builder/one-off", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
  revalidatePath("/[league]/schedule", "page");
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

/* ------------------------------------------------------ repair (items 3, 4) */

export type RepairPreview = {
  /** Index-aligned with the planner's team indices. */
  teams: { id: string; name: string }[];
  /** Index-aligned with the planner's night indices. */
  nights: { date: string; times: string[]; locked: boolean }[];
  plans: OneOffPlan[];
  /** Why the pin could not be honoured — shown instead of plans. */
  unmet: string | null;
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

/**
 * A season's nights with each one's ice times, as the pin resolves against them.
 *
 * ⚠️ Built from the season **as published**, never from a form's `slot_times`.
 * `slot_on` resolves against two different lists depending on the path in —
 * `generateSchedule` matches pins against the FORM's list, while the one-off
 * planner builds its list from the published games — and this is the third
 * caller. It takes the published list, like the planner, because the pin it is
 * resolving is about a night that already exists and already has ice times.
 *
 * A postponed game has no time of its own and gets a placeholder no stored time
 * can equal; dropping it instead would shift every later slot index on that
 * night.
 */
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
  const { teams, indexOf, nights } = await loadContext(seasonId, admin);
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

/**
 * Turn the manager's pin into the planner's index-based one, or say why it
 * cannot be turned into anything.
 *
 * ⛔ The time is matched against the night's PUBLISHED ice times, and one the
 * night does not run is refused rather than rounded to the nearest slot. A pin
 * quietly relocated is worse than one refused: the manager has no way to see it
 * happened.
 */
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
  if (slot < 0) return { error: `${wanted} isn't one of that night's ice times.` };
  return { pin: { kind: "slot_on", team, night, slot } };
}

/**
 * Plan a repair — with a pin (item 3) or without one (item 4). Reads only;
 * nothing is written until the manager picks a plan.
 *
 * ⛔ Goes nowhere near `generateSchedule` or `replace_published_schedule`. Both
 * refuse permanently once `season_is_started` trips, and a started season is
 * exactly what this exists for; see `planRepair` for the decision and §3 of the
 * repair spec for what happens if it is ever "unified" with the generator.
 */
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
    pin,
    slotPins: resolved.slotPins.length > 0 ? resolved.slotPins : undefined,
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
      plans: result.plans,
      unmet: result.unmet,
      nothingToImprove: result.nothingToImprove,
    },
  };
}

/**
 * Write a previewed repair.
 *
 * ⛔ AN UPSERT BY ID. Every changed game keeps the row it already had, so no
 * game gets a new id and no calendar subscription is invalidated — the property
 * §5 of the spec asks to be asserted, and the e2e does.
 *
 * The submitted changes are VALIDATED, not re-solved, for the reason
 * `applyOneOffGame` gives: both solvers stop on a wall-clock deadline, so two
 * runs may legitimately differ and re-solving would fail spuriously.
 * `checkOneOffWrite` IS the invariant — anything that passes it leaves
 * games-played, byes and weekday balance exactly as it found them, whatever the
 * client sent — and it is shared with the one-off path rather than reimplemented
 * here, so there is one definition of what a repair may not do.
 *
 * Changes are keyed by DATE, not by position, for the same reason: preview and
 * apply read the schedule independently, and an index would silently write the
 * plan to the wrong nights if anything shifted in between.
 */
export async function applyScheduleRepair(input: {
  seasonId: string;
  changes: { date: string; to: [number, number][] }[];
}): Promise<RepairState> {
  const admin = createAdminClient();
  const target = await targetSeasonForManager(admin, input.seasonId);
  if (!target) return { ok: false, message: "No season selected." };
  const { seasonId, manager } = target;

  if (input.changes.length === 0) {
    return { ok: false, message: "That plan changes nothing." };
  }

  const { teams, nights } = await loadContext(seasonId, admin);
  const teamIds = teams.map((t) => t.id);

  const problem = checkOneOffWrite({
    nights: nights.map((n) => ({
      date: n.date,
      locked: n.locked,
      games: n.games.map(
        (g) => [g.homeTeamId, g.awayTeamId] as [string, string],
      ),
    })),
    teamIds,
    // No labelled game on this path — see `CheckWriteOptions.date`.
    date: null,
    forcedPairs: [],
    changes: input.changes,
  });
  if (problem) return { ok: false, message: problem };

  const rows: TablesInsert<"games">[] = buildOneOffRows({
    nights,
    teamIds,
    date: null,
    round: "final",
    label: "",
    forcedPairs: [],
    changes: input.changes,
  }).map((r) => ({
    id: r.id,
    season_id: seasonId,
    home_team_id: r.homeTeamId,
    away_team_id: r.awayTeamId,
    label: r.label,
    // The game's own scheduled_at as just read, so this is a no-op for the row
    // it targets — it is here only because `upsert` INSERTS when no row matches,
    // and a game deleted between the read and the write would otherwise be
    // recreated with no date at all.
    scheduled_at: r.scheduledAt,
  }));

  if (rows.length === 0) {
    return { ok: false, message: "That plan changes nothing." };
  }

  // One statement, so a plan can't land half-applied.
  const { error } = await admin
    .from("games")
    .upsert(rows, { onConflict: "id" });
  if (error) return { ok: false, message: error.message };

  await logAudit({
    user_id: manager.id,
    action: "repair_schedule",
    entity_type: "season",
    entity_id: seasonId,
    old_data: { nights: input.changes.map((c) => c.date) },
    new_data: { games_rewritten: rows.length },
  });

  revalidatePath("/[league]/schedule-builder", "page");
  revalidatePath("/[league]/schedule-builder/repair", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
  revalidatePath("/[league]/schedule", "page");
  revalidatePath("/[league]", "page");

  const n = input.changes.length;
  return {
    ok: true,
    kind: "applied",
    message: `Repaired ${n} night${n === 1 ? "" : "s"} — ${rows.length} game${rows.length === 1 ? "" : "s"} rewritten, none re-created.`,
  };
}

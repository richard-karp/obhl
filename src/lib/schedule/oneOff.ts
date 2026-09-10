/**
 * Mid-season one-off games (a tournament final, semifinals) and the repair that
 * follows one.
 *
 * A one-off never creates a night. It lands on a night already in the published
 * schedule and takes over one of that night's games, which freezes participation
 * — the same teams play, the same teams sit out, the same number of games run.
 * Games played, byes and per-weekday counts therefore cannot move, and need no
 * repair.
 *
 * Three things do move, and all three are repaired here by re-running the
 * generator's own phases over the *unlocked* part of the season, with everything
 * already played pinned:
 *
 *   - who plays whom      → Phase M (`assignMatchups`)
 *   - per-team ice share   → Phase S (`assignSlots`)
 *   - the home/away split  → `assignHomeAway`
 *
 * Constraint satisfaction is primary. Churn — how much of the published schedule
 * the repair disturbs — is a tiebreaker among equally-good solutions, expressed
 * as a per-night penalty well below Phase M's `MULT_W`, never a reason to leave a
 * constraint unrepaired. Varying that penalty is what produces the alternative
 * plans a manager chooses between.
 */

import { assignMatchups, type NightConstraint } from "./matchups";
import { assignSlots } from "./slots";
import {
  assignHomeAway,
  homeAwaySpread,
  type OrientableGame,
} from "./homeAway";
import {
  buildNightMeta,
  spacingReport,
  type IceOutcome,
  type PlacedGame,
  type SpacingReport,
} from "./spacing";
import type { Night } from "./assignNights";

/** A plan's ice-time result, in the shape `compareIceOutcome` ranks. */
// Exported for the shape guard in `weightCoupling.test.ts`: this builds an
// `IceOutcome` for the REPAIR's ranking, so a field added to that type for the
// generator's sake has to arrive here too.
export const outcomeOf = (p: {
  slotSpreadAfter: number;
  spacingAfter: SpacingReport;
}): IceOutcome => ({
  seasonSpread: p.slotSpreadAfter,
  weekdaySpread: p.spacingAfter.slotWeekdaySpread,
  streak3: p.spacingAfter.slotStreak3,
  consecutive: p.spacingAfter.slotConsecutive,
  clusterWorst: p.spacingAfter.slotClusterWorstTeam,
  clusterTotal: p.spacingAfter.slotClusterWindows,
  // The repair does not re-run Phase P, so it takes no view on a manager's
  // `slot_bias`; every plan it compares carries the same 0 here and the term
  // cannot decide anything. What the repair DOES honour is `slot_on` — see the
  // pin note in `planOneOff` below.
  biasCost: 0,
});

/**
 * Churn weights. All sit far below Phase M's `MULT_W` (50_000) so opponent
 * balance is never traded for a quieter diff, and are sized against `SPACING_W`
 * (rematch terms 40–120, so a night contributes at most ~1000 of spacing cost):
 * `FEWEST` outweighs that and will accept worse spacing to touch fewer nights,
 * `SPACING` is a pure tiebreaker, `SOONEST` scales with distance from the
 * one-off so the repair lands early.
 */
// Exported for `weightCoupling.test.ts`, which pins these against `SPACING_W`
// and `MULT_W`. They are one side of a coupling no other test covers.
export const CHURN_W = { FEWEST: 5_000, SPACING: 1, SOONEST: 200 };

export type OneOffNight = {
  date: string;
  /** The night's games in ice-time order, each `[home, away]`. */
  games: [number, number][];
  /** Played, or otherwise off limits: the repair may not touch it. */
  locked: boolean;
};

export type NightChange = {
  night: number;
  from: [number, number][];
  to: [number, number][];
  /** False when the same teams still meet and only ice time or home/away moved. */
  matchupChanged: boolean;
};

export type OneOffPlan = {
  id: string;
  label: string;
  /** The write payload: every night whose arrangement differs, in night order. */
  changes: NightChange[];
  /** Nights where the matchups themselves changed. */
  matchupNights: number[];
  /**
   * Nights the same teams still face each other on — only the ice time or the
   * home side moved. A softer kind of change than a new opponent, but not
   * "ice time only": the orientation pass can flip home/away on a night whose
   * matchups it never touched.
   */
  sameOpponentNights: number[];
  /** Last night with a matchup change: when opponent balance is back on target. */
  settledNight: number | null;
  /** Pairs still off their target meeting count, if exact repair was unreachable. */
  drift: { pair: [number, number]; delta: number }[];
  spacingBefore: SpacingReport;
  spacingAfter: SpacingReport;
  slotSpreadBefore: number;
  slotSpreadAfter: number;
  homeAwaySpreadBefore: number;
  homeAwaySpreadAfter: number;
  /**
   * Ice-time metrics this plan leaves worse than the no-repair baseline — empty
   * when it is at least as good on all four, and always empty on `no-repair`
   * itself. A repair that regresses one of these is still offered, because the
   * alternative is offering nothing at all on seasons where every repair trades
   * one ice metric for another; it is flagged instead so the choice is the
   * user's rather than the search's. Measured against leaving the season alone,
   * not against the pre-edit schedule — those differ once the one-off lands.
   */
  worseThan: IceMetric[];
};

/** The ice-time metrics a repair is judged on, in the order the UI reads them. */
export type IceMetric =
  "seasonSpread" | "weekdaySpread" | "streak3" | "consecutive";

// ⛔ CLUSTERING IS DELIBERATELY ABSENT, and that is a decision, not an omission.
// `IceOutcome` carries `clusterWorst`/`clusterTotal` and `outcomeOf` builds
// them, so extending this list is a one-line change — do not make it casually.
// §5: the generator and the one-off repair rank ice time by different rules ON
// PURPOSE ("do not unify them"), because the repair is judged against leaving a
// published season alone rather than against a fresh search. Adding clustering
// here would start flagging repairs as regressions on a metric the repair has no
// mechanism to improve, on a season a manager has already seen.
//
// The cost of leaving it out, stated plainly: a repair that materially worsens
// clustering is offered without a `worseThan` flag and the dialog says nothing.
export const ICE_METRICS: IceMetric[] = [
  "seasonSpread",
  "weekdaySpread",
  "streak3",
  "consecutive",
];

/** How each metric reads in the repair dialog. */
export const ICE_METRIC_LABEL: Record<IceMetric, string> = {
  seasonSpread: "season ice-time share",
  weekdaySpread: "per-weekday ice-time share",
  streak3: "three-game ice-time runs",
  consecutive: "back-to-back ice times",
};

export type OneOffResult =
  | { ok: true; plans: OneOffPlan[]; relabelOnly: boolean }
  | { ok: false; reason: string };

export type PlanOneOffOptions = {
  teamCount: number;
  nights: OneOffNight[];
  /**
   * Index into `nights` — must be unlocked.
   *
   * **Null means there is no one-off game**, which is the repair-only mode
   * `planRepair` drives: the same three phases over the same unlocked nights,
   * with nothing forced onto any night. Everything keyed on this index — the
   * `require` constraint, the feature slot, the churn distance and the
   * no-repair baseline's freeze — reads differently in that mode, and each
   * place says how.
   */
  oneOffNight: number | null;
  /** The labelled game(s), as unordered pairs. Empty when there is no one-off. */
  forcedPairs: [number, number][];
  /**
   * ⛔ **The item-3 pin: MOVE a team's game onto an ice time, don't merely
   * preserve it.** This is the one thing `slotPins` below deliberately will not
   * do, and the difference is the whole distinction between honouring a stored
   * constraint (preserve what is already right) and acting on an instruction a
   * manager has just typed (put it right).
   *
   * `slot` is an index into the night's ice-time order — the order
   * `OneOffNight.games` is already in — resolved by the caller against the
   * season **as published**, never against a form's slot list. See §5 of the
   * repair spec: `slot_on` resolves against two different lists depending on the
   * path in, and this is the third caller.
   *
   * The team must already play that night. Participation is frozen by the
   * published schedule, so a pin for a team that byes is not something this can
   * do badly — it cannot do it at all, and `planRepair` reports it unmet rather
   * than quietly dropping it.
   */
  slotForce?: { night: number; team: number; slot: number };
  /** Hold the labelled game(s) on the night's last ice time(s). */
  featureSlot?: boolean;
  seed?: number;
  /**
   * ⛔ **WHAT THE MID-SEASON REPAIR DOES WITH MANAGER CONSTRAINTS — the decision,
   * written down where it will be read.**
   *
   * **The repair honours `slot_on` pins on the nights it touches, and ignores
   * the bye and play kinds entirely.**
   *
   * *Why the bye/play kinds are ignored:* they are participation decisions —
   * who plays which night — and the repair does not re-run Phase P. It is
   * handed a published season's participation as fixed and only re-pairs and
   * re-slots around a one-off. There is no matrix here to force, so honouring
   * them is not something this planner can decline to do well; it cannot do it
   * at all. A future repair that did move participation would have to revisit
   * this line.
   *
   * *Why `slot_on` IS honoured:* the repair re-slots every unfrozen night, and
   * `SCHEDULE_HANDOFF.md` §3 already records the shape of this hazard — a repair
   * that omits `weekdayOfNight` silently undoes what generation achieved. A
   * repair that silently re-slots a pinned game is the same failure with a
   * manager's explicit instruction as the casualty, and it would show up in week
   * nine as a pin that quietly stopped meaning anything.
   *
   * *What "honours" means here, exactly:* **preserve, do not repair.** A pin is
   * applied only when the published schedule still has that team's game on the
   * pinned ice time, in which case the game is held there while the night's
   * others permute around it. When the published schedule has already drifted
   * off the pin, the repair leaves it alone rather than dragging the game back —
   * moving a game the manager did not ask about, to satisfy a constraint the
   * published schedule already breaks, is a bigger surprise than the drift.
   *
   * Night indexes are into `nights`; `slot` is an index into that night's
   * ice-time order, which is the order `OneOffNight.games` is already in.
   */
  slotPins?: { night: number; team: number; slot: number }[];
};

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

const keyOf = (p: [number, number]) => pairKey(p[0], p[1]);

/** Order-independent identity of a night's matchups. */
const matchingKey = (ps: [number, number][]) => ps.map(keyOf).sort().join(",");

/** Σ per team of (most-used ice time − least-used), over teams that play. */
export function iceTimeSpread(
  teamCount: number,
  arranged: [number, number][][],
): number {
  const maxSlots = Math.max(1, ...arranged.map((a) => a.length));
  const counts = Array.from({ length: teamCount }, () =>
    new Array<number>(maxSlots).fill(0),
  );
  for (const night of arranged) {
    night.forEach((p, s) => {
      counts[p[0]][s]++;
      counts[p[1]][s]++;
    });
  }
  let total = 0;
  for (const c of counts) {
    if (c.every((v) => v === 0)) continue;
    total += Math.max(...c) - Math.min(...c);
  }
  return total;
}

/**
 * Put each new matchup back in the ice-time position its predecessor held, so a
 * night whose matchups didn't change reports no change at all. Phase M returns a
 * matching in arbitrary order, and without this every night would look edited.
 */
function alignToIncumbent(
  next: [number, number][],
  incumbent: [number, number][],
): [number, number][] {
  const placed: ([number, number] | null)[] = incumbent.map(() => null);
  const taken = new Set<number>();
  const leftover: [number, number][] = [];
  const incKeys = incumbent.map(keyOf);
  for (const p of next) {
    const k = keyOf(p);
    const i = incKeys.findIndex((ik, idx) => ik === k && !taken.has(idx));
    if (i >= 0) {
      placed[i] = p;
      taken.add(i);
    } else {
      leftover.push(p);
    }
  }
  let r = 0;
  return placed.map((s) => s ?? leftover[r++]);
}

/** Move the labelled game(s) to the end, so they take the night's last slots. */
function featureLast(
  games: [number, number][],
  forced: [number, number][],
): [number, number][] {
  const fk = new Set(forced.map(keyOf));
  return [
    ...games.filter((g) => !fk.has(keyOf(g))),
    ...games.filter((g) => fk.has(keyOf(g))),
  ];
}

function placedGames(arranged: [number, number][][]): PlacedGame[] {
  const out: PlacedGame[] = [];
  arranged.forEach((night, nightIndex) => {
    night.forEach(([home, away], slotIndex) => {
      out.push({
        home: String(home),
        away: String(away),
        nightIndex,
        slotIndex,
      });
    });
  });
  return out;
}

/**
 * Reject schedules the phases can't take. Published games aren't guaranteed to
 * come from the generator — the esportsdesk importer exists — so this is a real
 * path, and the
 * caller degrades to "no repair" rather than failing outright.
 */
function precheck(opts: PlanOneOffOptions): string | null {
  const { nights, oneOffNight, forcedPairs, teamCount, slotForce } = opts;
  if (nights.length === 0) return "This season has no scheduled games yet.";
  if (oneOffNight !== null) {
    if (oneOffNight < 0 || oneOffNight >= nights.length) {
      return "That date isn't a game night this season.";
    }
    if (nights[oneOffNight].locked) {
      return "That night has already been played.";
    }
  } else if (nights.every((n) => n.locked)) {
    // Repair-only mode. With every night locked there is nothing the phases are
    // allowed to move, and the search would return the schedule it was given.
    return "Every game night has already been played, so there's nothing left to repair.";
  }
  if (slotForce) {
    const night = nights[slotForce.night];
    if (!night) return "That date isn't a game night this season.";
    if (night.locked) return "That night has already been played.";
    if (slotForce.slot < 0 || slotForce.slot >= night.games.length) {
      return "That isn't one of that night's ice times.";
    }
    if (!night.games.flat().includes(slotForce.team)) {
      return "That team isn't scheduled to play that night.";
    }
  }
  for (const night of nights) {
    const seen = new Set<number>();
    for (const [h, a] of night.games) {
      if (h === a) return `${night.date} has a game against the same team.`;
      if (h < 0 || h >= teamCount || a < 0 || a >= teamCount) {
        return `${night.date} has a game for a team that isn't enrolled.`;
      }
      if (seen.has(h) || seen.has(a)) {
        return `${night.date} has a team playing twice that night, which this repair can't work with.`;
      }
      seen.add(h);
      seen.add(a);
    }
  }
  // Repair-only mode has no forced game, so every check below it is about a
  // one-off that isn't there.
  if (oneOffNight === null) return null;
  if (forcedPairs.length === 0) return "Pick the teams for the game.";
  const used = forcedPairs.flat();
  if (new Set(used).size !== used.length) {
    return "A team can't be in two of these games the same night.";
  }
  const playing = new Set(nights[oneOffNight].games.flat());
  const idle = used.filter((t) => !playing.has(t));
  if (idle.length > 0) {
    return "Every team in the game has to be already scheduled that night.";
  }
  if (nights[oneOffNight].games.length < forcedPairs.length) {
    return "That night doesn't run enough games for this round.";
  }
  return null;
}

/** A night as the write path sees it: real team ids, in ice-time order. */
export type WriteNight = {
  date: string;
  locked: boolean;
  games: [string, string][];
  /** The night's game ids, in the same ice-time order as `games`. */
  gameIds: string[];
};

/**
 * One night's new arrangement, as the client sends it back.
 *
 * ⛔ `gameIds` IS THE IDENTITY CHECK, AND IT IS NOT OPTIONAL DECORATION.
 * Everything else in a change is positional: `to[i]` is written onto the i-th
 * ice time of the night as read at APPLY. Preview and apply read the schedule
 * independently, and `groupIntoNights` sorts a night by time — so a single
 * `rescheduleGame` between the two steps reorders the night, and every other
 * check still passes (same teams, same count, same night) while the previewed
 * matchups land on the wrong ice slots. Sending the ids the plan was computed
 * against, in slot order, is what makes that reordering visible.
 */
export type PlannedNight = {
  date: string;
  to: [number, number][];
  /**
   * The night's game ids in slot order at PREVIEW time.
   *
   * ⛔ REQUIRED. It was optional while only the repair sent it, and the one-off
   * path — the shipped one — simply opted out and kept the hole. A guard every
   * caller may decline is not a guard.
   */
  gameIds: string[];
};

export type CheckWriteOptions = {
  nights: WriteNight[];
  /** Team ids by planner index — how `changes` refers to teams. */
  teamIds: string[];
  /**
   * The night the labelled game goes on, or **null on the repair path**, which
   * has no labelled game. The checks below split cleanly in two: the ones about
   * the one-off night, and the ones about the plan itself. Only the second half
   * applies when this is null, and the first half is what would otherwise reject
   * every repair for not naming a game night.
   */
  date: string | null;
  forcedPairs: [string, string][];
  changes: PlannedNight[];
};

const idKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Whether a previewed plan is safe to write — `null` if so, else why not.
 *
 * Separate from `planOneOff` because it guards a different thing. The planner
 * decides what *should* happen; this decides whether what came back from the
 * client may touch the database, re-checked against the schedule as it is now
 * rather than as it was at preview. Re-solving instead wouldn't work: both
 * solvers stop on a wall-clock deadline, so two runs can differ legitimately.
 *
 * These checks *are* the invariant. Any payload that passes leaves games-played,
 * byes and weekday balance exactly as it found them, whatever the client sent —
 * so it doesn't matter that the plan itself is client-supplied.
 *
 * Pure, and in this module rather than in the server action, so each rejection
 * can be tested without a database.
 */
export function checkOneOffWrite(opts: CheckWriteOptions): string | null {
  const { nights, teamIds, date, forcedPairs, changes } = opts;

  const nightOn = new Map(nights.map((n) => [n.date, n]));
  const oneOff = date === null ? null : nightOn.get(date);
  if (date !== null) {
    if (!oneOff) return "That date isn't a game night this season.";
    // Checked unconditionally, not just for nights in `changes`: when the teams
    // already meet that night the plan carries no changes at all, and this
    // night's lock state would otherwise never be examined.
    if (oneOff.locked) {
      return `${oneOff.date} has already been played — pick another night.`;
    }
    // On the relabel path the row builder writes this night's games straight
    // back, mapping their team ids through `teamIds`. A game for a team no
    // longer enrolled — unenrolling doesn't delete the games already scheduled
    // — has no index to map to, and would otherwise reach the write as a row
    // with no team on it. Preview rejects the same schedule; apply re-reads, so
    // it has to too.
    const enrolled = new Set(teamIds);
    for (const [h, a] of oneOff.games) {
      if (!enrolled.has(h) || !enrolled.has(a)) {
        return `${oneOff.date} has a game for a team that isn't enrolled this season.`;
      }
    }
  }

  const seen = new Set<string>();
  for (const c of changes) {
    const night = nightOn.get(c.date);
    if (!night) return "The schedule changed — preview it again.";
    if (seen.has(c.date)) return "That plan lists a night twice.";
    seen.add(c.date);
    if (night.locked) {
      return `${night.date} has already been played — preview it again.`;
    }
    if (c.to.length !== night.games.length) {
      return "The schedule changed — preview it again.";
    }
    // ⛔ The identity check — see `PlannedNight.gameIds`. Same games, same
    // order, or the slot mapping this plan was computed against no longer holds.
    if (
      c.gameIds.length !== night.gameIds.length ||
      c.gameIds.some((id, i) => id !== night.gameIds[i])
    ) {
      return `${night.date} has been re-timed since this plan was made — preview it again.`;
    }
    const after: string[] = [];
    for (const pair of c.to) {
      const home = teamIds[pair?.[0]];
      const away = teamIds[pair?.[1]];
      if (!home || !away || home === away) {
        return "That plan isn't a valid set of games.";
      }
      after.push(home, away);
    }
    if (new Set(after).size !== after.length) {
      return "That plan has a team playing twice in a night.";
    }
    // The heart of it: the same teams play, so nobody gains or loses a game,
    // a bye, or a weekday.
    const before = night.games.flat();
    if ([...before].sort().join() !== [...after].sort().join()) {
      return "That plan changes who plays that night, which would unbalance the season.";
    }
  }

  // Repair has no game being scheduled, so there is nothing for the plan to be
  // missing. Every check above it still applied.
  if (date === null || !oneOff) return null;

  const onNight =
    changes
      .find((c) => c.date === date)
      ?.to.map((p) => idKey(teamIds[p[0]], teamIds[p[1]])) ??
    oneOff.games.map((g) => idKey(g[0], g[1]));
  if (!forcedPairs.every((p) => onNight.includes(idKey(p[0], p[1])))) {
    return "That plan doesn't include the game being scheduled.";
  }

  return null;
}

export type OneOffRound = "final" | "semifinals";

/** Label for the i-th labelled game of a round. */
const labelFor = (round: OneOffRound, label: string, i: number) =>
  round === "semifinals" ? `Semifinal ${i + 1}` : label.trim() || "Final";

const SEMIFINAL_LABEL = /^Semifinal \d+$/;

/**
 * Whether a label already on the one-off night is this round's to clear.
 *
 * A round owns the labels it can itself produce: re-running semifinals clears
 * stale `Semifinal N`s, and a final clears a stale final whatever wording the
 * manager gave it. The other round's labels are left alone, so semifinals and a
 * final can share a night — three ice times, six teams — without erasing each
 * other.
 *
 * This is why it matches on the wording rather than on which round wrote the
 * row: `games` has no column saying which round a label came from. The cost is
 * that a final can't tell a stale final from any other custom label, so on a
 * final's night anything that isn't a `Semifinal N` is treated as its own.
 */
const roundOwnsLabel = (round: OneOffRound, label: string | null) =>
  label !== null &&
  (round === "semifinals"
    ? SEMIFINAL_LABEL.test(label)
    : !SEMIFINAL_LABEL.test(label));

/** A published game, as the write path reads it back. */
export type RowGame = {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  /**
   * Null for a postponed game, whose date was cleared. The repair only ever
   * builds rows for unlocked nights and a postponed game always locks its own,
   * so this should not arise — and if it ever did, writing the null back leaves
   * the game undated rather than resurrecting the date it was postponed from.
   */
  scheduledAt: string | null;
  label: string | null;
};

export type RowNight = { date: string; games: RowGame[] };

/**
 * One game to write: the same row, re-pointed at its new matchup.
 *
 * The `prev*` fields are what the row held before, so a write path that has to
 * undo a half-applied batch can put it back without re-reading — see
 * `applyGameWrites` in `actions/schedule.ts`.
 */
export type OneOffRow = RowGame & {
  prevHomeTeamId: string;
  prevAwayTeamId: string;
  prevLabel: string | null;
};

export type BuildRowsOptions = {
  /** The season's nights as read back, each night's games in ice-time order. */
  nights: RowNight[];
  /** Team ids by planner index — how `changes` refers to teams. */
  teamIds: string[];
  /**
   * The night the labelled game goes on, or **null on the repair path** — which
   * writes matchups and nothing else. With null, `round`, `label` and
   * `forcedPairs` are unused and no night is force-rewritten: a repair that
   * changes nothing writes nothing.
   */
  date: string | null;
  round: OneOffRound;
  /** The manager's wording for a final; ignored for semifinals. */
  label: string;
  forcedPairs: [string, string][];
  changes: { date: string; to: [number, number][] }[];
};

/**
 * The rows a chosen plan writes.
 *
 * A night's games keep their existing rows in ice-time order and only their
 * matchups move — the i-th planned game onto the i-th ice time — so "the set of
 * times per night is unchanged" holds structurally rather than by assertion.
 * Rows the plan leaves exactly as they were are omitted, so a quiet plan writes
 * little.
 *
 * Labels follow the game, not the row: one survives only where its matchup did,
 * and on the one-off night the round owns every label — the labelled games get
 * theirs, and anything else is cleared, which is what stops a second run leaving
 * two games called "Final".
 *
 * Pure, and separate from the action, so every one of those rules can be tested
 * without a database. Call it only on a payload `checkOneOffWrite` has passed:
 * it trusts that each change names a real night with a matching game count and
 * in-range team indices.
 */
export function buildOneOffRows(opts: BuildRowsOptions): OneOffRow[] {
  const { nights, teamIds, date, round, label, forcedPairs, changes } = opts;

  const nightOn = new Map(nights.map((n) => [n.date, n]));
  const oneOff = date === null ? null : nightOn.get(date);
  if (date !== null && !oneOff) return [];

  const indexOf = new Map(teamIds.map((id, i) => [id, i]));
  const forced = forcedPairs.map(([h, a]) => idKey(h, a));

  // The one-off night is always rewritten, even when the plan doesn't list it:
  // that's the relabel case, where the two teams already meet and the only edit
  // is the label. Standing in its current arrangement lets one loop handle both,
  // and the unchanged-row skip below keeps it from writing anything it needn't.
  //
  // Repair has no such night — there is no label to apply — so its changes are
  // the whole of the work, and a repair that changes nothing writes nothing.
  const all =
    !oneOff || changes.some((c) => c.date === date)
      ? changes
      : [
          ...changes,
          {
            date: oneOff.date,
            to: oneOff.games.map(
              (g) =>
                [indexOf.get(g.homeTeamId)!, indexOf.get(g.awayTeamId)!] as [
                  number,
                  number,
                ],
            ),
          },
        ];

  const rows: OneOffRow[] = [];
  for (const c of all) {
    const night = nightOn.get(c.date);
    // `checkOneOffWrite` rejects a change naming a night that isn't there, so
    // reaching this means it was bypassed. Loud beats a half-written plan.
    if (!night) throw new Error(`No game night on ${c.date}.`);
    /**
     * ⛔ LABELS FOLLOW THE MATCHUP, NOT THE ROW — which is what the header has
     * always claimed and what the code did not do.
     *
     * It used to read the label off `night.games[i]`, the row that happens to
     * sit on the i-th ice time. That is only the same thing while a plan never
     * permutes a night's slots. A one-off's plan rarely does on a night that
     * carries a label, so it survived; a REPAIR permutes slots for a living and
     * every night it touches is an ordinary night, so a season with a scheduled
     * Final could have that label silently wiped by an unrelated repair — the
     * two games swap ice times, neither is `kept` at its own index, and both
     * come out null. Keyed by pair, a matchup that is still on this night keeps
     * its label wherever it lands.
     */
    const labelOfPair = new Map(
      night.games.map((g) => [idKey(g.homeTeamId, g.awayTeamId), g.label]),
    );
    c.to.forEach(([h, a], i) => {
      const row = night.games[i];
      const home = teamIds[h];
      const away = teamIds[a];
      const key = idKey(home, away);
      const kept = key === idKey(row.homeTeamId, row.awayTeamId);
      // What this MATCHUP carried on this night, null if it wasn't here at all
      // — which is the honest replacement for the old "not kept, so clear it".
      const carried = labelOfPair.get(key) ?? null;
      const labelIndex = c.date === date ? forced.indexOf(key) : -1;
      const next =
        labelIndex >= 0
          ? labelFor(round, label, labelIndex)
          : c.date === date && roundOwnsLabel(round, carried)
            ? null
            : carried;
      if (kept && row.homeTeamId === home && row.label === next) return;
      rows.push({
        id: row.id,
        homeTeamId: home,
        awayTeamId: away,
        label: next,
        scheduledAt: row.scheduledAt,
        prevHomeTeamId: row.homeTeamId,
        prevAwayTeamId: row.awayTeamId,
        prevLabel: row.label,
      });
    });
  }
  return rows;
}

export function planOneOff(opts: PlanOneOffOptions): OneOffResult {
  const {
    teamCount: T,
    nights,
    oneOffNight,
    forcedPairs,
    featureSlot = true,
    seed = 1,
    slotPins,
    slotForce,
  } = opts;

  const reason = precheck(opts);
  if (reason) return { ok: false, reason };

  /**
   * Which night the churn weightings measure distance from, and which one the
   * no-repair baseline is allowed to move.
   *
   * With a one-off it is the one-off's night, as it always was. Without one it
   * is the pinned night when there is a pin, else the first night the repair may
   * touch — so "put it right soonest" still means "land the changes early"
   * rather than "land them near night zero", which on a half-played season is a
   * night the repair may not touch at all.
   */
  const focusNight =
    oneOffNight ??
    slotForce?.night ??
    Math.max(
      0,
      nights.findIndex((n) => !n.locked),
    );

  const N = nights.length;
  const incumbent = nights.map((n) => n.games);

  // The target is the schedule as published: its meeting counts are what the
  // repair has to land back on. Locked nights contribute fixed meetings the free
  // nights have to work around.
  const targets = Array.from({ length: T }, () => new Array<number>(T).fill(0));
  const plays = Array.from({ length: T }, () =>
    new Array<boolean>(N).fill(false),
  );
  nights.forEach((night, n) => {
    for (const [h, a] of night.games) {
      targets[h][a]++;
      targets[a][h]++;
      plays[h][n] = true;
      plays[a][n] = true;
    }
  });

  const reportNights: Night[] = nights.map((n) => ({
    date: n.date,
    slots: [],
  }));
  const meta = buildNightMeta(reportNights);
  const teamIds = Array.from({ length: T }, (_, i) => String(i));
  const spacingBefore = spacingReport(
    placedGames(incumbent),
    reportNights,
    teamIds,
  );
  const slotSpreadBefore = iceTimeSpread(T, incumbent);
  const homeAwaySpreadBefore = homeAwaySpread(T, incumbent.flat());

  // Already playing each other that night? Then this is a pure relabel — no
  // matchup moves, so nothing to repair. Repair-only mode has no forced pair to
  // be already met, so it never takes this exit.
  const onNight = new Set(
    oneOffNight === null ? [] : incumbent[oneOffNight].map(keyOf),
  );
  if (oneOffNight !== null && forcedPairs.every((p) => onNight.has(keyOf(p)))) {
    return {
      ok: true,
      relabelOnly: true,
      plans: [
        {
          id: "relabel",
          label: "No changes needed",
          changes: [],
          matchupNights: [],
          sameOpponentNights: [],
          settledNight: null,
          drift: [],
          spacingBefore,
          spacingAfter: spacingBefore,
          slotSpreadBefore,
          slotSpreadAfter: slotSpreadBefore,
          homeAwaySpreadBefore,
          homeAwaySpreadAfter: homeAwaySpreadBefore,
          worseThan: [], // changes nothing, so it cannot be worse than anything
        },
      ],
    };
  }

  const incumbentKeys = incumbent.map(matchingKey);

  /**
   * One plan: Phase M, then Phase S, then orientation — the generator's own
   * order, since matchups fix participation for slots and orientation is
   * independent of both.
   *
   * `freeze` narrows which nights may move at all; the no-repair baseline uses
   * it to confine the edit to the one-off night.
   */
  function build(
    id: string,
    label: string,
    churn: (night: number) => number,
    restarts: number,
    timeBudgetMs: number,
    freeze?: (night: number) => boolean,
  ): OneOffPlan | null {
    const frozen = nights.map(
      (n, i) => n.locked || (freeze ? freeze(i) : false),
    );

    const nightConstraints: (NightConstraint | null)[] = nights.map((n, i) => {
      // `oneOffNight === null` (repair-only) never matches, so no night is
      // required to hold a particular pair and Phase M is free everywhere it is
      // not frozen.
      if (i === oneOffNight) return { kind: "require", pairs: forcedPairs };
      if (frozen[i]) return { kind: "fixed", pairs: incumbent[i] };
      return null;
    });

    const m = assignMatchups({
      teamCount: T,
      plays,
      nightWeek: meta.week,
      nightWeekday: meta.weekday,
      targets,
      seed,
      restarts,
      timeBudgetMs,
      nightConstraints,
      initial: incumbent,
      nightPenalty: (night, pairs) =>
        matchingKey(pairs) === incumbentKeys[night] ? 0 : churn(night),
    });
    if (!m) return null;

    // Keep unchanged matchups on the ice time they already had, then hand the
    // labelled game the feature slot if the manager asked for it.
    let pairsByNight = m.pairsByNight.map((ps, n) =>
      alignToIncumbent(ps, incumbent[n]),
    );
    if (featureSlot && oneOffNight !== null) {
      pairsByNight = pairsByNight.map((ps, n) =>
        n === oneOffNight ? featureLast(ps, forcedPairs) : ps,
      );
    }

    /**
     * The item-3 pin, as Phase S can act on it.
     *
     * `assignSlots`'s `pinned` holds a game on the slot `initial` gave it, so
     * MOVING a game to a slot means seeding `initial` with the identity packing
     * swapped at those two positions and then pinning the game. The game that
     * was on the requested ice time takes the pinned game's old slot and is
     * free to move again from there.
     *
     * Resolved after Phase M and `alignToIncumbent`, not before: Phase M may
     * have given the pinned team a different opponent, and the pin is about the
     * team's ice time, not about which game it is.
     */
    const forcedNight = slotForce?.night ?? -1;
    const forcedGame =
      slotForce === undefined
        ? -1
        : pairsByNight[forcedNight].findIndex((p) =>
            p.includes(slotForce.team),
          );
    const forcedInitial =
      forcedGame < 0
        ? undefined
        : (() => {
            const init = pairsByNight[forcedNight].map((_, gi) => gi);
            init[forcedGame] = slotForce!.slot;
            init[slotForce!.slot] = forcedGame;
            return init;
          })();

    const slotOf = assignSlots({
      teamCount: T,
      pairsByNight,
      slotsPerNight: pairsByNight.map((ps) => ps.length),
      weekdayOfNight: meta.weekday,
      // Without this the repair scores ice-time share season-wide only and
      // quietly undoes the per-weekday split generation achieved.
      seed,
      // Let the clock be the bound, not the kick count — Phase S's loop stops at
      // whichever comes first, and a frozen-night repair needs the kicks.
      restarts: Number.MAX_SAFE_INTEGER,
      timeBudgetMs: 600,
      initial: pairsByNight.map((ps, n) =>
        n === forcedNight && forcedInitial
          ? forcedInitial
          : ps.map((_, gi) => gi),
      ),
      frozen,
      pinned: nights.map((_, n) => {
        // The manager's just-typed pin outranks everything else on its night:
        // it is the instruction the whole plan was asked for.
        if (n === forcedNight && forcedGame >= 0) return [forcedGame];
        if (featureSlot && oneOffNight !== null && n === oneOffNight) {
          return pairsByNight[n]
            .map((_, gi) => gi)
            .slice(pairsByNight[n].length - forcedPairs.length);
        }
        // Manager `slot_on` pins — see `PlanOneOffOptions.slotPins` for the
        // decision this implements. `initial` above is the identity packing over
        // `pairsByNight`, which `alignToIncumbent` has just put in the published
        // night's ice-time order, so a game's index here IS its current slot.
        // The pin therefore applies exactly when the team's game is already sitting
        // on the requested one: preserve, never drag back.
        //
        // The one-off's own night is excluded. Its participation is what the
        // whole repair is changing, and the feature slot above is the manager's
        // more recent instruction about that night's ice.
        if (!slotPins || n === oneOffNight) return undefined;
        const held: number[] = [];
        for (const pin of slotPins) {
          if (pin.night !== n) continue;
          const gi = pairsByNight[n].findIndex(
            ([a, b]) => a === pin.team || b === pin.team,
          );
          if (gi >= 0 && gi === pin.slot) held.push(gi);
        }
        return held.length > 0 ? held : undefined;
      }),
    });

    // Settle each night into ice-time order before orienting, so home/away is
    // decided on the arrangement that will actually be written.
    const arranged: [number, number][][] = pairsByNight.map((ps, n) => {
      const row = new Array<[number, number]>(ps.length);
      ps.forEach((p, gi) => {
        row[slotOf[n][gi]] = p;
      });
      return row;
    });

    // Orientation follows the matchup, not the ice time: a pair that already met
    // on this night keeps the home/away it had.
    const orientable: OrientableGame[] = [];
    arranged.forEach((night, n) => {
      const priorByKey = new Map(incumbent[n].map((g) => [keyOf(g), g]));
      for (const p of night) {
        orientable.push({
          pair: p,
          locked: frozen[n],
          current: priorByKey.get(keyOf(p)),
        });
      }
    });
    const oriented = assignHomeAway({ teamCount: T, games: orientable, seed });
    let cursor = 0;
    const final: [number, number][][] = arranged.map((night) =>
      night.map(() => oriented[cursor++]),
    );

    const changes: NightChange[] = [];
    const matchupNights: number[] = [];
    const sameOpponentNights: number[] = [];
    for (let n = 0; n < N; n++) {
      const same =
        final[n].length === incumbent[n].length &&
        final[n].every(
          (p, i) => p[0] === incumbent[n][i][0] && p[1] === incumbent[n][i][1],
        );
      if (same) continue;
      const matchupChanged = matchingKey(final[n]) !== incumbentKeys[n];
      changes.push({
        night: n,
        from: incumbent[n],
        to: final[n],
        matchupChanged,
      });
      (matchupChanged ? matchupNights : sameOpponentNights).push(n);
    }

    const actual = Array.from({ length: T }, () =>
      new Array<number>(T).fill(0),
    );
    for (const night of final) {
      for (const [h, a] of night) {
        actual[h][a]++;
        actual[a][h]++;
      }
    }
    const drift: { pair: [number, number]; delta: number }[] = [];
    for (let a = 0; a < T; a++) {
      for (let b = a + 1; b < T; b++) {
        const delta = actual[a][b] - targets[a][b];
        if (delta !== 0) drift.push({ pair: [a, b], delta });
      }
    }

    return {
      id,
      label,
      changes,
      matchupNights,
      sameOpponentNights,
      settledNight: matchupNights.length
        ? matchupNights[matchupNights.length - 1]
        : null,
      drift,
      spacingBefore,
      spacingAfter: spacingReport(placedGames(final), reportNights, teamIds),
      slotSpreadBefore,
      slotSpreadAfter: iceTimeSpread(T, final),
      homeAwaySpreadBefore,
      homeAwaySpreadAfter: homeAwaySpread(T, final.flat()),
      worseThan: [], // filled in below, once the baseline to compare against exists
    };
  }

  const candidates = [
    // The baseline first: everything but the one-off night held still, so the
    // cost of doing nothing is visible rather than implied. In repair-only mode
    // `oneOffNight` is null, so `n !== oneOffNight` freezes EVERY night and the
    // baseline is literally the published schedule — which is the right
    // reference there too, and what "nothing to improve" is measured against.
    build(
      "no-repair",
      "Leave the rest of the season alone",
      () => 0,
      1,
      400,
      (n) => n !== oneOffNight,
    ),
    build(
      "soonest",
      "Put it right soonest",
      (n) => CHURN_W.SOONEST * (1 + Math.abs(n - focusNight)),
      12,
      900,
    ),
    build("fewest", "Disturb the fewest games", () => CHURN_W.FEWEST, 12, 900),
    build(
      "spacing",
      "Best resulting schedule",
      () => CHURN_W.SPACING,
      16,
      1_500,
    ),
  ].filter((p): p is OneOffPlan => p !== null);

  // Fails closed rather than falling back: the no-repair baseline is itself an
  // `assignMatchups` result, so when the enumeration ceiling trips there's
  // nothing left to fall back to short of a solver-free pairing path — which
  // would run on exactly the schedules whose structure we know least about.
  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        "This schedule is too large or too irregular for the repair to work with — it may have been imported rather than generated.",
    };
  }

  // Two weightings often land on the same edit; show it once.
  const seen = new Set<string>();
  const plans: OneOffPlan[] = [];
  for (const p of candidates) {
    const sig = p.changes
      .map((c) => `${c.night}:${c.to.map((g) => g.join(">")).join("|")}`)
      .join(";");
    if (seen.has(sig)) continue;
    seen.add(sig);
    plans.push(p);
  }

  // A repair that leaves the season worse on ice time than doing nothing is not
  // much of a repair. The search descends on a blended scalar, which can trade
  // any one of these metrics for a gain in another, so check each against the
  // no-repair baseline separately rather than through a ranking that would let
  // a win on the first term excuse a loss on the rest.
  //
  // Flagged rather than dropped: on seasons where every repair trades one ice
  // metric for another, dropping would leave the user with no repair offered at
  // all for a schedule that still needs one. The plan is shown with the
  // regression named, which is the honest version of the same guarantee.
  //
  // No baseline means no way to check, and `worseThan: []` would then be an
  // unverified claim wearing a verified one's clothes. Fail closed instead, the
  // same way a declined Phase M does above — an honest refusal beats plans
  // carrying a guarantee nobody tested. Unreachable today: the baseline freezes
  // every night but the one-off, so it is the plan *least* likely to be declined,
  // and anything that declines it declines the others too.
  const baselinePlan = plans.find((p) => p.id === "no-repair");
  if (!baselinePlan) {
    return {
      ok: false,
      reason:
        "This schedule is too large or too irregular for the repair to work with — it may have been imported rather than generated.",
    };
  }
  const base = outcomeOf(baselinePlan);
  for (const p of plans) {
    if (p.id === "no-repair") continue;
    const mine = outcomeOf(p);
    p.worseThan = ICE_METRICS.filter((m) => mine[m] > base[m]);
  }

  return { ok: true, plans, relabelOnly: false };
}

/* -------------------------------------------------------------- item 3 & 4 */

/**
 * What a manager can pin on a season that is already published.
 *
 * The same vocabulary the generator speaks, narrowed to the two kinds a repair
 * can act on at all. The bye kinds are absent on purpose: they are participation
 * decisions, and repair does not move participation.
 */
export type RepairPin =
  | { kind: "play_on"; team: number; night: number }
  | { kind: "slot_on"; team: number; night: number; slot: number };

export type RepairResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      plans: OneOffPlan[];
      /**
       * Why the pin could not be honoured, in terms a manager can act on — null
       * when there was no pin, or it was honoured.
       *
       * ⛔ NOT AN ERROR, AND NOT SILENCE EITHER. The obvious reading of "X needs
       * to play that night" is that repair will add them to it, and it will not:
       * participation is frozen by the published schedule, so adding a team to a
       * night changes byes, which unbalances the season. Reporting it unmet with
       * the reason is the honest answer, and the UI has to show it.
       */
      unmet: string | null;
      /**
       * True when the pin is already met AND the only repairs the search found
       * would move the team off it — so there is something to improve, and
       * honouring the instruction is what costs it.
       */
      pinBlocksImprovement?: boolean;
      /**
       * True when the published schedule ALREADY satisfied the pin, so the pin
       * did not steer anything.
       *
       * ⚠️ A `play_on` pin that is satisfiable is by definition already met —
       * repair cannot add a team to a night, so the only pin it can honour is
       * one that is already true. Without this the page shows plans next to a
       * pin the manager believes produced them, when the run was an ordinary
       * repair. Same for a `slot_on` whose game is already on that ice time.
       */
      pinAlreadyMet: boolean;
      /**
       * True when the search found nothing worth doing — every candidate came
       * back identical to the published schedule. ⚠️ Item 4 must be able to say
       * this rather than offer a plan that churns nights for a score that did
       * not move.
       */
      nothingToImprove: boolean;
    };

export type PlanRepairOptions = {
  teamCount: number;
  nights: OneOffNight[];
  /** The manager's instruction, or null to simply repair what is there. */
  pin: RepairPin | null;
  seed?: number;
  /** The season's stored `slot_on` constraints — preserved, never dragged back. */
  slotPins?: { night: number; team: number; slot: number }[];
};

/**
 * Repair a published season — with a pin (item 3) or without one (item 4).
 *
 * ⛔ THE SAME ENGINE AS `planOneOff`, DELIBERATELY. There are exactly two write
 * paths onto `games`, and only this one survives `season_is_started`:
 * `generateSchedule` → `replace_published_schedule` refuses permanently once the
 * season is under way, while a plan from here is applied as an ordinary upsert
 * by id. Unifying repair with the generator "for symmetry" would break it on
 * precisely the seasons it exists to serve, and the failure would arrive in
 * production rather than in a test.
 *
 * **What repair can and cannot move.** Participation is frozen: who plays on
 * which night is fixed by the published schedule, so games played, byes and
 * per-weekday counts cannot change. What it moves is who plays whom, the ice
 * time, and home/away. A `play_on` pin for a team that byes that night is
 * therefore not satisfiable, and comes back in `unmet` rather than being
 * quietly dropped.
 *
 * The zero-change baseline is not offered as a plan: "leave it alone" is what
 * happens when the manager applies nothing, and listing it as something to
 * choose invites choosing it by accident. It is still built, because it is the
 * reference every plan's `worseThan` is measured against.
 */
export function planRepair(opts: PlanRepairOptions): RepairResult {
  const { teamCount, nights, pin, seed, slotPins } = opts;

  // Participation first, because it is the one thing no plan can change — and
  // saying so before spending the search budget is both faster and clearer.
  if (pin) {
    const night = nights[pin.night];
    if (!night) {
      return { ok: false, reason: "That date isn't a game night this season." };
    }
    if (night.locked) {
      return {
        ok: false,
        reason: "That night has already been played, so it can't be changed.",
      };
    }
    if (!night.games.flat().includes(pin.team)) {
      return {
        ok: true,
        plans: [],
        pinAlreadyMet: false,
        nothingToImprove: false,
        unmet:
          "That team has a bye that night, and a repair can't add it to one — that would change who plays, which changes every team's byes. Move a single game with Reschedule instead, or regenerate the schedule if the season hasn't started.",
      };
    }
    if (
      pin.kind === "slot_on" &&
      (pin.slot < 0 || pin.slot >= night.games.length)
    ) {
      const n = night.games.length;
      return {
        ok: true,
        plans: [],
        pinAlreadyMet: false,
        nothingToImprove: false,
        unmet: `That night runs ${n} game${n === 1 ? "" : "s"}, so that isn't one of its ice times.`,
      };
    }
  }

  const result = planOneOff({
    teamCount,
    nights,
    // No one-off game: this is the repair-only mode of the same planner.
    oneOffNight: null,
    forcedPairs: [],
    featureSlot: false,
    seed,
    slotPins,
    slotForce:
      pin?.kind === "slot_on"
        ? { night: pin.night, team: pin.team, slot: pin.slot }
        : undefined,
  });
  if (!result.ok) return result;

  // Drop the do-nothing plans, the baseline among them. A plan with no changes
  // is not a choice, and offering one alongside real ones reads as though the
  // search found two answers.
  const plans = result.plans.filter((p) => p.changes.length > 0);

  /**
   * ⛔ CHECK THE PIN ACTUALLY LANDED. DO NOT ASSUME IT.
   *
   * `slotForce` reaches Phase S as an `initial` packing plus a `pinned` index,
   * and if the pinned team's game cannot be located on that night the pin
   * quietly becomes `undefined` — the search runs, plans come back, and every
   * one of them ignores the instruction the manager typed while `unmet` still
   * says null. That is the silent failure this whole feature is supposed not to
   * have, and it was reasoned away ("Phase M preserves participation, so the
   * game is always found") rather than asserted. Asserted now.
   *
   * A plan that did not honour the pin is dropped, not shown with a warning: the
   * manager asked for one specific thing, and a list of plans that all decline
   * it is worse than being told it could not be done.
   */
  if (pin?.kind === "slot_on") {
    // Was it already true before any plan? That is a different answer from
    // "the search could not do it", and saying the wrong one of the two is how
    // a manager concludes the feature is broken when it simply had no work.
    const already =
      nights[pin.night].games.findIndex((g) => g.includes(pin.team)) ===
      pin.slot;
    const landed = plans.filter((p) => {
      const after =
        p.changes.find((c) => c.night === pin.night)?.to ??
        nights[pin.night].games;
      return after.findIndex((g) => g.includes(pin.team)) === pin.slot;
    });
    if (landed.length === 0) {
      return already
        ? {
            ok: true,
            plans: [],
            unmet: null,
            pinAlreadyMet: true,
            // ⚠️ NOT `nothingToImprove`. The search DID find improvements —
            // they were dropped because every one of them moved the pinned
            // team off the ice time it was asked to keep. Saying "nothing to
            // improve" about a season with repairs available is a different
            // claim, and a false one.
            nothingToImprove: plans.length === 0,
            pinBlocksImprovement: plans.length > 0,
          }
        : {
            ok: true,
            plans: [],
            pinAlreadyMet: false,
            nothingToImprove: false,
            unmet:
              "The repair couldn't put that team on that ice time without changing something it isn't allowed to — who plays that night is fixed by the published schedule. Try another ice time on that night, or move the single game with Reschedule.",
          };
    }
    return {
      ok: true,
      plans: landed,
      unmet: null,
      pinAlreadyMet: already,
      nothingToImprove: false,
    };
  }

  return {
    ok: true,
    plans,
    unmet: null,
    // A `play_on` pin that got this far is satisfiable, which means the team
    // already plays that night — so it is met, and the repair it triggered is an
    // ordinary one. The UI has to say that rather than imply the pin steered it.
    pinAlreadyMet: pin?.kind === "play_on",
    nothingToImprove: plans.length === 0,
  };
}

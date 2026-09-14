// ⚠️ A one-off never creates a night, so participation is frozen: repair re-runs Phases M and S
// and orientation on unlocked nights only. RUNBOOK.md, _Schedule edits and exports_.

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

/** The repair's `IceOutcome`. ⚠️ A field added to that type for the generator must arrive here
 *  too; `weightCoupling.test.ts` guards the shape. */
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
  // Repair takes no view on `slot_bias` (no Phase P): every plan compares an equal 0.
  biasCost: 0,
});

// ⚠️ Far below `MULT_W`, so opponent balance is never traded for a quieter diff. Moves with
// `MULT_W` and `SPACING_W`; `weightCoupling.test.ts` pins the ratios.
export const CHURN_W = { FEWEST: 5_000, SPACING: 1, SOONEST: 200 };

export type OneOffNight = {
  date: string;
  /** The night's games in ice-time order, each `[home, away]`. */
  games: [number, number][];
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
  matchupNights: number[];
  /** Same opponents, but not "ice time only": orientation can flip home/away here too. */
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
  /** Ice metrics this plan leaves worse than no repair, not than the pre-edit season.
   *  ⚠️ Flagged, not dropped: RUNBOOK.md, _Schedule edits and exports_. */
  worseThan: IceMetric[];
};

/** The ice-time metrics a repair is judged on, in the order the UI reads them. */
export type IceMetric =
  "seasonSpread" | "weekdaySpread" | "streak3" | "consecutive";

// ⛔ Clustering is absent on purpose: repair is judged against leaving the season alone and
// can't improve it. Don't unify with generation: RUNBOOK.md, _Schedule edits and exports_.
export const ICE_METRICS: IceMetric[] = [
  "seasonSpread",
  "weekdaySpread",
  "streak3",
  "consecutive",
];

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
  /** Index into `nights`, unlocked. **Null is repair-only mode** (`planRepair`): no night is
   *  forced, and everything keyed on this index reads differently. */
  oneOffNight: number | null;
  /** The labelled game(s), as unordered pairs. Empty when there is no one-off. */
  forcedPairs: [number, number][];
  /**
  /** ⛔ Moves a team's game onto an ice time, unlike `slotPins`, which only preserve. `slot` is
   *  resolved against the season as published, never a form's list; the team must already play. */
  slotForce?: { night: number; team: number; slot: number };
  /** Hold the labelled game(s) on the night's last ice time(s). */
  featureSlot?: boolean;
  seed?: number;
  /** ⛔ Preserve, never drag back: a pin holds only while its game still has that ice time,
   *  and bye and play kinds are ignored. RUNBOOK.md, _Schedule edits and exports_. */
  slotPins?: { night: number; team: number; slot: number }[];
};

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

const keyOf = (p: [number, number]) => pairKey(p[0], p[1]);

const matchingKey = (ps: [number, number][]) => ps.map(keyOf).sort().join(",");

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

/** Puts each matchup back on its predecessor's ice time: Phase M's order is arbitrary, and
 *  without this every night would look edited. */
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

/** Rejects schedules the phases can't take: published games needn't come from the generator. */
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

export type WriteNight = {
  date: string;
  locked: boolean;
  games: [string, string][];
  /** The night's game ids, in the same ice-time order as `games`. */
  gameIds: string[];
};

/** ⛔ `gameIds` is the identity check: the rest is positional, so a reschedule between preview
 *  and apply lands matchups on the wrong ice times while every other check passes. */
export type PlannedNight = {
  date: string;
  to: [number, number][];
  /** The night's game ids in slot order at PREVIEW. ⛔ Required: a guard any caller may
   *  decline is not a guard. */
  gameIds: string[];
};

export type CheckWriteOptions = {
  nights: WriteNight[];
  /** Team ids by planner index — how `changes` refers to teams. */
  teamIds: string[];
  /** The one-off's night, or null on the repair path, where only the checks on the plan apply. */
  date: string | null;
  forcedPairs: [string, string][];
  changes: PlannedNight[];
};

const idKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** ⚠️ Re-checks a client-supplied plan against the schedule as it is now; re-solving can't, as
 *  both solvers stop on a clock. Passing leaves games, byes and weekday balance unchanged. */
export function checkOneOffWrite(opts: CheckWriteOptions): string | null {
  const { nights, teamIds, date, forcedPairs, changes } = opts;

  const nightOn = new Map(nights.map((n) => [n.date, n]));
  const oneOff = date === null ? null : nightOn.get(date);
  if (date !== null) {
    if (!oneOff) return "That date isn't a game night this season.";
    // ⚠️ Checked even when `changes` omits this night: when the teams already meet, the plan
    // carries no changes and the lock would go unexamined.
    if (oneOff.locked) {
      return `${oneOff.date} has already been played — pick another night.`;
    }
    // ⚠️ The relabel path writes this night's games back through `teamIds`; a game for an
    // unenrolled team has no index and would write a row with no team.
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
    // ⛔ The identity check: see `PlannedNight.gameIds`.
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
    // The same teams play, so nobody gains or loses a game, a bye or a weekday.
    const before = night.games.flat();
    if ([...before].sort().join() !== [...after].sort().join()) {
      return "That plan changes who plays that night, which would unbalance the season.";
    }
  }

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

const labelFor = (round: OneOffRound, label: string, i: number) =>
  round === "semifinals" ? `Semifinal ${i + 1}` : label.trim() || "Final";

const SEMIFINAL_LABEL = /^Semifinal \d+$/;

/** Whether a label on the one-off night is this round's to clear. ⚠️ Matched on wording (no
 *  column records the round), so a final treats any label but `Semifinal N` as its own. */
const roundOwnsLabel = (round: OneOffRound, label: string | null) =>
  label !== null &&
  (round === "semifinals"
    ? SEMIFINAL_LABEL.test(label)
    : !SEMIFINAL_LABEL.test(label));

export type RowGame = {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  /** Null for a postponed game. ⚠️ Written back as is, never `postponed_from`, which would
   *  resurrect a cleared date. RUNBOOK.md, _Schedule edits and exports_. */
  scheduledAt: string | null;
  label: string | null;
};

export type RowNight = { date: string; games: RowGame[] };

/** The same row, re-pointed; `prev*` is what it held, which the write checks it still holds. */
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
  /** The one-off's night, or null on the repair path, which writes matchups only. */
  date: string | null;
  round: OneOffRound;
  /** The manager's wording for a final; ignored for semifinals. */
  label: string;
  forcedPairs: [string, string][];
  changes: { date: string; to: [number, number][] }[];
};

/** The rows a plan writes: matchups move onto existing rows in ice-time order; labels follow the
 *  matchup. ⚠️ Only for a payload `checkOneOffWrite` passed: it trusts nights and indices. */
export function buildOneOffRows(opts: BuildRowsOptions): OneOffRow[] {
  const { nights, teamIds, date, round, label, forcedPairs, changes } = opts;

  const nightOn = new Map(nights.map((n) => [n.date, n]));
  const oneOff = date === null ? null : nightOn.get(date);
  if (date !== null && !oneOff) return [];

  const indexOf = new Map(teamIds.map((id, i) => [id, i]));
  const forced = forcedPairs.map(([h, a]) => idKey(h, a));

  // The one-off night is always rewritten, even when unlisted: that is the relabel case.
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
    // Only reachable if `checkOneOffWrite` was bypassed: loud beats a half-written plan.
    if (!night) throw new Error(`No game night on ${c.date}.`);
    /** ⛔ Labels follow the matchup, not the row: keyed by slot, a repair that swaps two games'
     *  ice times silently wipes a scheduled Final's label. */
    const labelOfPair = new Map(
      night.games.map((g) => [idKey(g.homeTeamId, g.awayTeamId), g.label]),
    );
    c.to.forEach(([h, a], i) => {
      const row = night.games[i];
      const home = teamIds[h];
      const away = teamIds[a];
      const key = idKey(home, away);
      const kept = key === idKey(row.homeTeamId, row.awayTeamId);
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

  /** Where churn distance is measured from: the one-off's night, else the pinned night, else
   *  the first night the repair may touch. */
  const focusNight =
    oneOffNight ??
    slotForce?.night ??
    Math.max(
      0,
      nights.findIndex((n) => !n.locked),
    );

  const N = nights.length;
  const incumbent = nights.map((n) => n.games);

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

  /** One plan: Phase M, Phase S, then orientation. `freeze` confines the no-repair baseline. */
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

    let pairsByNight = m.pairsByNight.map((ps, n) =>
      alignToIncumbent(ps, incumbent[n]),
    );
    if (featureSlot && oneOffNight !== null) {
      pairsByNight = pairsByNight.map((ps, n) =>
        n === oneOffNight ? featureLast(ps, forcedPairs) : ps,
      );
    }

    /** The `slotForce` pin as Phase S takes it: seed `initial` with the two slots swapped, then
     *  pin. ⚠️ Resolved after Phase M, which may have changed the pinned team's opponent. */
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
      // ⚠️ Without `weekdayOfNight` the repair quietly undoes the per-weekday split generation
      // achieved. RUNBOOK.md, _Schedule edits and exports_.
      seed,
      // The clock bounds it, not the kick count: a frozen-night repair needs the kicks.
      restarts: Number.MAX_SAFE_INTEGER,
      timeBudgetMs: 600,
      initial: pairsByNight.map((ps, n) =>
        n === forcedNight && forcedInitial
          ? forcedInitial
          : ps.map((_, gi) => gi),
      ),
      frozen,
      pinned: nights.map((_, n) => {
        if (n === forcedNight && forcedGame >= 0) return [forcedGame];
        if (featureSlot && oneOffNight !== null && n === oneOffNight) {
          return pairsByNight[n]
            .map((_, gi) => gi)
            .slice(pairsByNight[n].length - forcedPairs.length);
        }
        // `alignToIncumbent` left published order, so an index is the current slot: a `slot_on`
        // pin holds only where its game already sits. The one-off's own night is excluded.
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

    const arranged: [number, number][][] = pairsByNight.map((ps, n) => {
      const row = new Array<[number, number]>(ps.length);
      ps.forEach((p, gi) => {
        row[slotOf[n][gi]] = p;
      });
      return row;
    });

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
    // The baseline: all but the one-off night frozen (in repair-only mode, every night), so
    // doing nothing is a plan to compare against.
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

  // Fails closed: the baseline is itself an `assignMatchups` result, so there is nothing to
  // fall back to but a solver-free path on the schedules we understand least.
  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        "This schedule is too large or too irregular for the repair to work with — it may have been imported rather than generated.",
    };
  }

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

  // ⚠️ Each metric against no repair separately, flagged not dropped, and no baseline fails
  // closed (`[]` would be unverified). Don't unify: RUNBOOK.md, _Schedule edits and exports_.
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

/** Pins a repair can act on. Bye kinds are absent on purpose: repair doesn't move participation. */
export type RepairPin =
  | { kind: "play_on"; team: number; night: number }
  | { kind: "slot_on"; team: number; night: number; slot: number };

export type RepairResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      plans: OneOffPlan[];
      /** Why the pin couldn't be honoured, or null. ⛔ Not an error and not silence: repair
       *  can't add a team to a night (that changes byes), and the UI must say so. */
      unmet: string | null;
      /** The pin is met, and every improvement found would move the team off it. */
      pinBlocksImprovement?: boolean;
      /** The published schedule already met the pin. ⚠️ Without it the page implies the pin
       *  produced the plans; a satisfiable `play_on` is always already met. */
      pinAlreadyMet: boolean;
      /** Every candidate came back identical to the published schedule. */
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

/** ⛔ The same engine as `planOneOff`, on purpose: only this path still writes once a season
 *  has started, so never unify it with generation. RUNBOOK.md, _Schedule edits and exports_. */
export function planRepair(opts: PlanRepairOptions): RepairResult {
  const { teamCount, nights, pin, seed, slotPins } = opts;

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

  // Drop the do-nothing plans, baseline included: a plan with no changes is not a choice.
  const plans = result.plans.filter((p) => p.changes.length > 0);

  /** ⛔ Check the pin landed; don't assume it: an unlocatable game quietly drops the pin while
   *  `unmet` stays null. A plan that ignores the pin is dropped, not shown with a warning. */
  if (pin?.kind === "slot_on") {
    // Already true before any plan is a different answer from "couldn't do it".
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
            // ⚠️ Not `nothingToImprove`: improvements existed, but every one moved the pinned
            // team off its ice time.
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
    // A `play_on` that got this far is already met, so the repair is an ordinary one.
    pinAlreadyMet: pin?.kind === "play_on",
    nothingToImprove: plans.length === 0,
  };
}

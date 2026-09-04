/**
 * Manager schedule constraints — what a league manager asks the generator for,
 * and how those requests reach the three phases.
 *
 * ## The load-bearing observation
 *
 * A team's bye budget is fixed at `nights − gamesPerTeam`. Forcing a bye onto a
 * night therefore **moves** a bye; it never adds one. Total games per team,
 * games per night, and how many times each pair meets are untouched by
 * everything in this file — constraints are pure rearrangements inside the
 * feasible space the generator already searches. Nothing here relaxes a
 * structural property, and the acceptance test asserts exactly that.
 *
 * ## Stored meaning, resolved indices
 *
 * The database stores what the manager *meant* — `{date: "2026-11-12"}`,
 * `{week_of: "2026-11-09"}`, `{time: "21:30"}` — never a solver index. A week
 * number shifts the moment a skip date is added and a slot position shifts the
 * moment an ice time is inserted; a date and a wall-clock time do not.
 * Resolution to indices happens here, once, at generation time.
 *
 * ## A constraint can outlive what it names
 *
 * `on delete cascade` covers a deleted team, but **un-enrolling a team from a
 * season deletes no team row**, and a stored date stops being a game night the
 * moment the manager changes the weekdays or adds a skip date. Both cases
 * resolve to `unresolved` with a reason and are reported unmet. Nothing here
 * indexes into a team list that may not contain the team.
 */

import { buildNightMeta, weekIndexOf, type SlotBias } from "./spacing";
import type { Night } from "./assignNights";

export const CONSTRAINT_KINDS = [
  "bye_on",
  "bye_in_week",
  "bye_week",
  "play_on",
  "slot_on",
  "slot_bias",
] as const;

export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export function isConstraintKind(v: unknown): v is ConstraintKind {
  return (CONSTRAINT_KINDS as readonly string[]).includes(String(v));
}

/**
 * What the manager asked for, exactly as stored.
 *
 * `params` is deliberately loose: it is a `jsonb` column, and a row written by
 * an older version of the app (or by hand) must degrade to "unresolved, here is
 * why" rather than throw inside the generator.
 */
export type ConstraintParams = {
  /** `bye_on`, `play_on`, `slot_on` — a specific game night. */
  date?: string;
  /** `bye_in_week`, `bye_week` — ANY date inside the intended week. */
  week_of?: string;
  /** `slot_on` — the wall-clock ice time, "HH:MM". */
  time?: string;
  /** `slot_bias` — inclusive date window. */
  from?: string;
  to?: string;
  /** `slot_bias` — which end of the evening. */
  prefer?: "early" | "late";
};

export type ScheduleConstraint = {
  id: string;
  teamId: string;
  kind: ConstraintKind;
  params: ConstraintParams;
};

/** One constraint, resolved against a concrete calendar. */
export type ResolvedConstraint = {
  source: ScheduleConstraint;
  /**
   * Why this constraint could not be turned into solver indices, or null when
   * it could. An unresolved constraint contributes nothing to any phase and is
   * reported unmet with this as its reason.
   */
  unresolved: string | null;
  /** Team index into `teamIds`, or −1 when the team is no longer enrolled. */
  team: number;
  /** Phase P pre-assignments this constraint contributes. */
  forced: { team: number; night: number; plays: boolean }[];
  /** Phase P disjunction ("at least one bye among this week's nights"). */
  byeInWeek: { team: number; week: number } | null;
  /** Phase S pin. */
  slotPin: { team: number; night: number; slot: number } | null;
  /** Phase S cost term. */
  bias: SlotBias | null;
  /** Night indexes this constraint is about, for evaluation and messages. */
  nights: number[];
};

export type ResolvedConstraints = {
  items: ResolvedConstraint[];
  forced: { team: number; night: number; plays: boolean }[];
  byeInWeek: { team: number; week: number }[];
  slotPins: { team: number; night: number; slot: number }[];
  biases: SlotBias[];
  /**
   * True when nothing at all reaches a solver phase. **Every caller gates its
   * new branch on this**: with no constraints the generator must behave
   * bit-identically to how it did before this feature existed, and the cheapest
   * way to guarantee that is to not enter the new code at all.
   */
  empty: boolean;
};

const EMPTY: ResolvedConstraints = {
  items: [],
  forced: [],
  byeInWeek: [],
  slotPins: [],
  biases: [],
  empty: true,
};

export const noConstraints = (): ResolvedConstraints => EMPTY;

const isDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v: unknown): v is string =>
  typeof v === "string" && /^\d{2}:\d{2}$/.test(v);

/** A short human sentence for a constraint, for refusals and the preview. */
export function describeConstraint(
  c: Pick<ScheduleConstraint, "kind" | "params">,
  teamName: string,
): string {
  const p = c.params ?? {};
  switch (c.kind) {
    case "bye_on":
      return `${teamName} byes on ${p.date ?? "?"}`;
    case "play_on":
      return `${teamName} plays on ${p.date ?? "?"}`;
    case "bye_week":
      return `${teamName} byes the whole week of ${p.week_of ?? "?"}`;
    case "bye_in_week":
      return `${teamName} byes once in the week of ${p.week_of ?? "?"}`;
    case "slot_on":
      return `${teamName} plays at ${p.time ?? "?"} on ${p.date ?? "?"}`;
    case "slot_bias":
      return `${teamName} prefers ${p.prefer ?? "early"} ice from ${p.from ?? "?"} to ${p.to ?? "?"}`;
  }
}

/**
 * Turn stored constraints into solver indices against one concrete calendar.
 *
 * Never throws and never returns a partial index: anything that does not
 * resolve is marked `unresolved` and dropped from every phase list.
 */
export function resolveConstraints(
  constraints: ScheduleConstraint[],
  opts: { nights: Night[]; teamIds: string[] },
): ResolvedConstraints {
  const { nights, teamIds } = opts;
  if (constraints.length === 0) return EMPTY;

  const teamIndex = new Map(teamIds.map((t, i) => [t, i]));
  const nightOfDate = new Map<string, number>();
  nights.forEach((n, i) => {
    if (!nightOfDate.has(n.date)) nightOfDate.set(n.date, i);
  });
  const meta = buildNightMeta(nights);
  const nightsOfWeek = new Map<number, number[]>();
  meta.week.forEach((w, i) => {
    (nightsOfWeek.get(w) ?? nightsOfWeek.set(w, []).get(w)!).push(i);
  });

  const items: ResolvedConstraint[] = [];
  for (const source of constraints) {
    const p = source.params ?? {};
    const team = teamIndex.get(source.teamId) ?? -1;
    const item: ResolvedConstraint = {
      source,
      unresolved: null,
      team,
      forced: [],
      byeInWeek: null,
      slotPin: null,
      bias: null,
      nights: [],
    };
    items.push(item);

    // Un-enrolling a team deletes no team row, so its constraints survive it.
    if (team < 0) {
      item.unresolved = "that team is no longer enrolled in this season";
      continue;
    }

    const nightOn = (date: unknown): number | null => {
      if (!isDate(date)) return null;
      const n = nightOfDate.get(date);
      return n === undefined ? null : n;
    };

    switch (source.kind) {
      case "bye_on":
      case "play_on":
      case "slot_on": {
        const n = nightOn(p.date);
        if (n === null) {
          item.unresolved = isDate(p.date)
            ? `${p.date} is not a game night in this schedule`
            : "no valid date was stored";
          continue;
        }
        item.nights = [n];
        if (source.kind === "bye_on") {
          item.forced = [{ team, night: n, plays: false }];
          break;
        }
        // ⛔ `slot_on` IMPLIES `play_on`. Phase P decides who plays; Phase M
        // pairs them; only then does a game index exist for Phase S to pin. If
        // the play night is not forced, Phase P may hand the team a bye and the
        // pin becomes vacuously unsatisfiable — the manager's request silently
        // evaporates with nothing to point at.
        item.forced = [{ team, night: n, plays: true }];
        if (source.kind === "play_on") break;
        if (!isTime(p.time)) {
          item.unresolved = "no valid ice time was stored";
          item.forced = [];
          continue;
        }
        const slot = nights[n].slots.indexOf(p.time);
        if (slot < 0) {
          item.unresolved = `${p.time} is not an ice time on ${p.date}`;
          item.forced = [];
          continue;
        }
        item.slotPin = { team, night: n, slot };
        break;
      }
      case "bye_week":
      case "bye_in_week": {
        if (!isDate(p.week_of)) {
          item.unresolved = "no valid week was stored";
          continue;
        }
        const w = weekIndexOf(p.week_of, nights);
        const list = w === null ? undefined : nightsOfWeek.get(w);
        if (!list || list.length === 0) {
          item.unresolved = `the week of ${p.week_of} holds no game nights`;
          continue;
        }
        item.nights = list;
        if (source.kind === "bye_week") {
          item.forced = list.map((night) => ({ team, night, plays: false }));
        } else {
          item.byeInWeek = { team, week: w! };
        }
        break;
      }
      case "slot_bias": {
        if (!isDate(p.from) || !isDate(p.to) || p.from > p.to) {
          item.unresolved = "no valid date range was stored";
          continue;
        }
        const prefer = p.prefer === "late" ? "late" : "early";
        const mask = nights.map((n) => n.date >= p.from! && n.date <= p.to!);
        const list = mask.flatMap((inWindow, i) => (inWindow ? [i] : []));
        if (list.length === 0) {
          item.unresolved = `no game nights fall between ${p.from} and ${p.to}`;
          continue;
        }
        item.nights = list;
        item.bias = { team, nights: mask, prefer };
        break;
      }
    }
  }

  const forced = items.flatMap((i) => (i.unresolved ? [] : i.forced));
  const byeInWeek = items.flatMap((i) =>
    !i.unresolved && i.byeInWeek ? [i.byeInWeek] : [],
  );
  const slotPins = items.flatMap((i) =>
    !i.unresolved && i.slotPin ? [i.slotPin] : [],
  );
  const biases = items.flatMap((i) => (!i.unresolved && i.bias ? [i.bias] : []));
  return {
    items,
    forced,
    byeInWeek,
    slotPins,
    biases,
    empty:
      forced.length === 0 &&
      byeInWeek.length === 0 &&
      slotPins.length === 0 &&
      biases.length === 0,
  };
}

/**
 * Direct contradictions between two constraints — checked **before** any
 * arithmetic, because these are the likeliest thing a manager actually does
 * wrong and they deserve a message naming both offending requests rather than a
 * generic "infeasible".
 *
 * Returns one sentence per contradiction, empty when there are none.
 */
export function constraintConflicts(
  resolved: ResolvedConstraints,
  nameOf: (teamId: string) => string,
): string[] {
  const out: string[] = [];
  const label = (i: ResolvedConstraint) =>
    describeConstraint(i.source, nameOf(i.source.teamId));

  // Same team, same night, asked to both play and bye.
  const byCell = new Map<string, ResolvedConstraint[]>();
  for (const item of resolved.items) {
    if (item.unresolved) continue;
    for (const f of item.forced) {
      const k = `${f.team}:${f.night}`;
      (byCell.get(k) ?? byCell.set(k, []).get(k)!).push(item);
    }
  }
  for (const group of byCell.values()) {
    const plays = group.filter((i) => i.forced.some((f) => f.plays));
    const byes = group.filter((i) => i.forced.some((f) => !f.plays));
    if (plays.length && byes.length) {
      out.push(
        `“${label(plays[0])}” and “${label(byes[0])}” contradict each other — the same team cannot both play and bye that night.`,
      );
    }
  }

  // Two teams pinned to one sheet of ice at one time, or one team pinned to two.
  const bySlot = new Map<string, ResolvedConstraint[]>();
  const byTeamNight = new Map<string, ResolvedConstraint[]>();
  for (const item of resolved.items) {
    if (item.unresolved || !item.slotPin) continue;
    const { team, night, slot } = item.slotPin;
    const sk = `${night}:${slot}`;
    (bySlot.get(sk) ?? bySlot.set(sk, []).get(sk)!).push(item);
    const tk = `${team}:${night}`;
    (byTeamNight.get(tk) ?? byTeamNight.set(tk, []).get(tk)!).push(item);
  }
  for (const group of bySlot.values()) {
    // ⛔ TWO IS NOT A CONFLICT. A slot holds one game, and a game holds two
    // teams — so two teams pinned to the same ice time may simply be asking to
    // play each other there, which is satisfiable and used to be refused.
    // Phase M has not paired anyone when this runs, so whether they are
    // opponents is unknowable here; the honest line is to refuse only what no
    // pairing could satisfy, and let `evaluateConstraints` report the rest off
    // the placed games. Three teams cannot share one sheet under any pairing.
    if (group.length < 3) continue;
    // Two teams in the same game share a slot legitimately; two pins on
    // different teams are only a conflict if they cannot be the same game, and
    // whether they are is Phase M's decision — so this refuses either way and
    // says why. Pinning both halves of an intended matchup is expressed by
    // pinning one of them.
    out.push(
      `“${label(group[0])}”, “${label(group[1])}” and ${group.length - 2} other request${group.length === 3 ? "" : "s"} all claim the same ice time that night — one sheet of ice seats two teams.`,
    );
  }
  for (const group of byTeamNight.values()) {
    if (group.length < 2) continue;
    out.push(
      `“${label(group[0])}” and “${label(group[1])}” pin the same team to two ice times on one night.`,
    );
  }
  return dedupe(out);
}

const dedupe = (xs: string[]) => [...new Set(xs)];

/**
 * Arithmetic refutation, run before any search — the same class of check as
 * `solveParticipation`'s existing `O(teams × weekdays)` pre-checks, and for the
 * same reason: an impossible request should be refused in under a millisecond
 * with a sentence the manager can act on, not by a search that runs its budget
 * out and reports "couldn't place any games".
 *
 * Two counts, both exact:
 *   - a team's bye budget is `nights − gamesPerTeam`, and forced byes plus
 *     `bye_in_week` weeks that hold no forced bye all have to fit inside it;
 *   - a night hands out exactly `teams − 2 × games` byes, and no more teams
 *     than that can be forced off it (nor more than `2 × games` forced onto it).
 */
export function refuteConstraints(
  resolved: ResolvedConstraints,
  opts: {
    teamIds: string[];
    nameOf: (teamId: string) => string;
    /** Games each team plays over the season, by team index. */
    gamesPerTeam: number[];
    /** Games each night holds, by night index. */
    gamesPerNight: number[];
    /** Calendar-week index of each night — `buildNightMeta(nights).week`. */
    weekOfNight: number[];
  },
): string[] {
  if (resolved.empty) return [];
  const { teamIds, nameOf, gamesPerTeam, gamesPerNight, weekOfNight } = opts;
  const T = teamIds.length;
  const N = gamesPerNight.length;
  const out: string[] = [];

  const byeNights: Set<number>[] = Array.from({ length: T }, () => new Set());
  const playNights: Set<number>[] = Array.from({ length: T }, () => new Set());
  for (const f of resolved.forced) {
    (f.plays ? playNights : byeNights)[f.team]?.add(f.night);
  }
  const byeWeeks: Set<number>[] = Array.from({ length: T }, () => new Set());
  for (const b of resolved.byeInWeek) byeWeeks[b.team]?.add(b.week);

  for (let t = 0; t < T; t++) {
    const budget = N - (gamesPerTeam[t] ?? 0);
    const forcedWeeks = new Set([...byeNights[t]].map((n) => weekOfNight[n]));
    // A `bye_in_week` on a week that already holds a forced bye is satisfied by
    // it, so it costs nothing extra.
    const extra = [...byeWeeks[t]].filter((w) => !forcedWeeks.has(w)).length;
    const need = byeNights[t].size + extra;
    if (need > budget) {
      out.push(
        `${nameOf(teamIds[t])} is asked for ${need} bye${need === 1 ? "" : "s"} but only has ${budget} in a ${N}-night season — drop a bye request or shorten the schedule.`,
      );
    }
    if (playNights[t].size > (gamesPerTeam[t] ?? 0)) {
      out.push(
        `${nameOf(teamIds[t])} is pinned to ${playNights[t].size} game nights but only plays ${gamesPerTeam[t] ?? 0} games.`,
      );
    }
  }

  for (let n = 0; n < N; n++) {
    const byesAvailable = T - 2 * gamesPerNight[n];
    let forcedOff = 0;
    let forcedOn = 0;
    for (let t = 0; t < T; t++) {
      if (byeNights[t].has(n)) forcedOff++;
      if (playNights[t].has(n)) forcedOn++;
    }
    if (forcedOff > byesAvailable) {
      out.push(
        `${forcedOff} teams are asked to bye one night that only has ${byesAvailable} bye${byesAvailable === 1 ? "" : "s"} to give — that night runs ${gamesPerNight[n]} games.`,
      );
    }
    if (forcedOn > 2 * gamesPerNight[n]) {
      out.push(
        `${forcedOn} teams are pinned to one night that only seats ${2 * gamesPerNight[n]} — that night runs ${gamesPerNight[n]} games.`,
      );
    }
  }
  return dedupe(out);
}

export type ConstraintOutcome = {
  id: string;
  teamId: string;
  kind: ConstraintKind;
  satisfied: boolean;
  /** Why not, when `satisfied` is false. Null when it is. */
  reason: string | null;
};

/** The reason every constraint carries when the fallback planner shipped. */
export const FALLBACK_PLANNER_REASON =
  "the fallback planner produced a better schedule overall, and it cannot honour constraints";

/**
 * Did each constraint actually land?
 *
 * ⛔ **Decided by reading the final placed games, never by trusting what a phase
 * was asked to do.** `assignNights` already rebuilds `slotOf` off the placed
 * games rather than plumbing it out of Phase S, precisely because later steps
 * can move things. Verifying the request against itself would report a pin as
 * honoured whether or not it survived.
 *
 * The one deliberate exception is `plannerHonours: false`. `planByWeeks`
 * searches over placed games and has no participation matrix to force, so when
 * it wins the rank-off nothing was ever applied. A constraint that happens to
 * hold in its output holds by accident and would not survive a re-generate, so
 * reporting it met would be a false claim that the manager's instruction
 * worked. Everything is reported unmet, naming the planner.
 */
export function evaluateConstraints(
  resolved: ResolvedConstraints,
  opts: {
    /** `plays[team][night]` — read off the placed games. */
    plays: boolean[][];
    /** The slot a team took on a night, or null when it byed. */
    slotOf: (team: number, night: number) => number | null;
    /** False when the winning plan came from a planner that cannot force cells. */
    plannerHonours: boolean;
  },
): ConstraintOutcome[] {
  const { plays, slotOf, plannerHonours } = opts;
  /**
   * How many ice times night `n` actually handed out, from the placed games.
   *
   * ⛔ NOT the night's ice-time list. Phase S assigns a PERMUTATION over that
   * night's games, so a slot index runs 0…games−1 — a night with three sheets
   * but two games only ever uses slots 0 and 1. Counting sheets would put the
   * midpoint below any slot the night can reach and call every early request
   * unmet.
   */
  const gamesOn = (n: number) => {
    let seats = 0;
    for (const row of plays) if (row[n]) seats++;
    return seats / 2;
  };
  return resolved.items.map((item) => {
    const base = {
      id: item.source.id,
      teamId: item.source.teamId,
      kind: item.source.kind,
    };
    if (item.unresolved) {
      return { ...base, satisfied: false, reason: item.unresolved };
    }
    if (!plannerHonours) {
      return { ...base, satisfied: false, reason: FALLBACK_PLANNER_REASON };
    }
    const t = item.team;
    const played = (n: number) => plays[t]?.[n] === true;
    switch (item.source.kind) {
      case "bye_on":
        return verdict(base, !played(item.nights[0]), "the team plays that night");
      case "play_on":
        return verdict(base, played(item.nights[0]), "the team byes that night");
      case "bye_week":
        return verdict(
          base,
          item.nights.every((n) => !played(n)),
          "the team plays at least one night that week",
        );
      case "bye_in_week":
        return verdict(
          base,
          item.nights.some((n) => !played(n)),
          "the team plays every night that week",
        );
      case "slot_on": {
        const n = item.nights[0];
        if (!played(n)) return verdict(base, false, "the team byes that night");
        const got = slotOf(t, n);
        return verdict(
          base,
          got === item.slotPin!.slot,
          got === null
            ? "no game was placed for that team that night"
            : "the game landed on a different ice time",
        );
      }
      case "slot_bias": {
        const played1 = item.nights.filter((n) => played(n));
        if (played1.length === 0) {
          return verdict(base, false, "the team plays no games in that range");
        }
        const slots = played1
          .map((n) => slotOf(t, n))
          .filter((s): s is number => s !== null);
        if (slots.length === 0) {
          return verdict(base, false, "the team plays no games in that range");
        }
        // Best-effort by construction: `slot_bias` is a cost term ranked below
        // every real ice-time goal, so "satisfied" means the team's average ice
        // time over the window really does sit on the requested side of the
        // evening, not that every single game did.
        //
        // ⛔ THE MIDPOINT COMES FROM THE ICE AVAILABLE, NOT FROM THE SLOTS THIS
        // TEAM HAPPENED TO TAKE. Deriving it from the team's own observed max is
        // the obvious shortcut and it inverts the verdict at the best possible
        // outcome: a team given slot 0 every single night has an observed max of
        // 0, so the midpoint is 0 too, and `mean < mid` is `0 < 0` — the perfect
        // result reported as unmet. Measured 2026-09-04; `late` passed the same
        // probe, because its observed max is the real one. Per-night, because a
        // night running two games and a night running three do not have the same
        // middle.
        const mean = slots.reduce((a, b) => a + b, 0) / slots.length;
        const nightsPlayed = played1.filter((n) => slotOf(t, n) !== null);
        const midOf = (n: number) => (gamesOn(n) - 1) / 2;
        const expected =
          nightsPlayed.reduce((a, n) => a + midOf(n), 0) / nightsPlayed.length;
        // The best this team could have done, for the degenerate nights where
        // leaning is not on offer — one game on a night is slot 0 and also the
        // last slot, and a request over such a window is met by definition.
        const best =
          item.bias!.prefer === "early"
            ? 0
            : nightsPlayed.reduce((a, n) => a + (gamesOn(n) - 1), 0) /
              nightsPlayed.length;
        const ok =
          item.bias!.prefer === "early"
            ? mean < expected || mean <= best
            : mean > expected || mean >= best;
        return verdict(
          base,
          ok,
          `the team's ice times over that range average slot ${(mean + 1).toFixed(1)}, ` +
            `against a middle of ${(expected + 1).toFixed(1)}`,
        );
      }
    }
  });
}

function verdict(
  base: { id: string; teamId: string; kind: ConstraintKind },
  satisfied: boolean,
  reason: string,
): ConstraintOutcome {
  return { ...base, satisfied, reason: satisfied ? null : reason };
}

/** The four bye counts, as `spacingReport` names them. */
export type ByeCredits = {
  byesMultiWeek: number;
  byesConsecWeek: number;
  byesConsecWeekSameDay: number;
  byesAdjNight: number;
};

export const ZERO_CREDITS: ByeCredits = {
  byesMultiWeek: 0,
  byesConsecWeek: 0,
  byesConsecWeekSameDay: 0,
  byesAdjNight: 0,
};

/**
 * Bye-rule breaches the manager's own forced byes made unavoidable.
 *
 * ⛔ These are subtracted **when presenting metrics only**. `byeRuleCost` and
 * `buildMinAdjTable` in `participation.ts` are untouched: that cost is both the
 * search objective *and* the basis of the admissible lower bound, and
 * subtracting forced breaches from the objective without re-deriving the DP
 * risks an inadmissible bound, which prunes optimal solutions and silently
 * costs Phase P its exactness.
 *
 * Not touching it is also correct on its own terms. A forced cell is *fixed*,
 * so the breach it causes is constant across every feasible solution; the search
 * cannot avoid it and will not waste effort trying.
 *
 * **Attribution rule: a breach is credited only when every bye involved in it is
 * a forced one.** That is precisely the set the solver had no freedom over. A
 * week holding one forced bye and one the solver chose is *not* credited — the
 * solver could have put that second bye elsewhere, so it is collateral, and
 * collateral is the thing this feature exists to make visible rather than hide.
 * `bye_week` forces every cell in its week, so its rule-1 breach is always
 * credited, which is the acceptance gate.
 */
export function forcedByeCredits(
  resolved: ResolvedConstraints,
  opts: {
    nights: Night[];
    teamIds: string[];
    /** True when the team sat out that night, read off the placed games. */
    byed: (team: number, night: number) => boolean;
  },
): ByeCredits {
  if (resolved.empty) return ZERO_CREDITS;
  const { nights, teamIds, byed } = opts;
  const forcedBye = new Set<string>();
  for (const f of resolved.forced) if (!f.plays) forcedBye.add(`${f.team}:${f.night}`);
  if (forcedBye.size === 0) return ZERO_CREDITS;

  const meta = buildNightMeta(nights);
  const credits: ByeCredits = { ...ZERO_CREDITS };
  const isForced = (t: number, n: number) => forcedBye.has(`${t}:${n}`);

  for (let t = 0; t < teamIds.length; t++) {
    const byeWeekdays = new Map<number, Set<number>>();
    const allForcedInWeek = new Map<number, boolean>();
    for (const w of meta.sortedWeeks) {
      const byedNights = meta.weekNights.get(w)!.filter((ni) => byed(t, ni));
      if (byedNights.length === 0) continue;
      const everyOneForced = byedNights.every((ni) => isForced(t, ni));
      allForcedInWeek.set(w, everyOneForced);
      byeWeekdays.set(w, new Set(byedNights.map((ni) => meta.weekday[ni])));
      if (byedNights.length >= 2 && everyOneForced) credits.byesMultiWeek++;
    }
    for (let i = 1; i < meta.sortedWeeks.length; i++) {
      const a = meta.sortedWeeks[i - 1];
      const b = meta.sortedWeeks[i];
      if (b - a !== 1) continue;
      const wa = byeWeekdays.get(a);
      const wb = byeWeekdays.get(b);
      if (!wa || !wb) continue;
      if (!allForcedInWeek.get(a) || !allForcedInWeek.get(b)) continue;
      credits.byesConsecWeek++;
      if ([...wa].some((d) => wb.has(d))) credits.byesConsecWeekSameDay++;
    }
    for (let ni = 1; ni < nights.length; ni++) {
      if (!byed(t, ni) || !byed(t, ni - 1)) continue;
      if (isForced(t, ni) && isForced(t, ni - 1)) credits.byesAdjNight++;
    }
  }
  return credits;
}

/** Per-team bye metrics, so a reader can see which breaches sit on which team. */
export type TeamByeMetrics = ByeCredits & { team: string; constrained: boolean };

export function perTeamByeMetrics(opts: {
  nights: Night[];
  teamIds: string[];
  byed: (team: number, night: number) => boolean;
  /** Team indexes carrying at least one resolved constraint. */
  constrained: Set<number>;
}): TeamByeMetrics[] {
  const { nights, teamIds, byed, constrained } = opts;
  const meta = buildNightMeta(nights);
  return teamIds.map((team, t) => {
    const row: TeamByeMetrics = {
      team,
      constrained: constrained.has(t),
      ...ZERO_CREDITS,
    };
    const byeWeekdays = new Map<number, Set<number>>();
    for (const w of meta.sortedWeeks) {
      const byedNights = meta.weekNights.get(w)!.filter((ni) => byed(t, ni));
      if (byedNights.length === 0) continue;
      if (byedNights.length >= 2) row.byesMultiWeek++;
      byeWeekdays.set(w, new Set(byedNights.map((ni) => meta.weekday[ni])));
    }
    for (let i = 1; i < meta.sortedWeeks.length; i++) {
      const a = meta.sortedWeeks[i - 1];
      const b = meta.sortedWeeks[i];
      if (b - a !== 1) continue;
      const wa = byeWeekdays.get(a);
      const wb = byeWeekdays.get(b);
      if (!wa || !wb) continue;
      row.byesConsecWeek++;
      if ([...wa].some((d) => wb.has(d))) row.byesConsecWeekSameDay++;
    }
    for (let ni = 1; ni < nights.length; ni++) {
      if (byed(t, ni) && byed(t, ni - 1)) row.byesAdjNight++;
    }
    return row;
  });
}

/** Team indexes named by at least one resolved constraint. */
export function constrainedTeams(resolved: ResolvedConstraints): Set<number> {
  const out = new Set<number>();
  for (const item of resolved.items) {
    if (item.unresolved || item.team < 0) continue;
    out.add(item.team);
  }
  return out;
}

/**
 * The bye metrics as a manager should read them: raw, less the breaches their
 * own forced byes made unavoidable.
 *
 * One function so the number on screen and the number a test asserts on cannot
 * drift. The solver's `byeRuleCost` still counts every breach, by design — see
 * `forcedByeCredits`.
 */
export function presentSpacing<T extends ByeCredits>(raw: T, credits: ByeCredits): T {
  // ⚠️ FLOORED AT ZERO, because the two sides are not always counted over the
  // same teams. `spacingReport` counts teams that have games; the credits are
  // counted over every enrolled team. A constrained team the generator could
  // place no games for is therefore credited byes that were never charged, and
  // the subtraction would print a negative bye count — a number that cannot
  // mean anything to the person reading it.
  const floor = (n: number) => Math.max(0, n);
  return {
    ...raw,
    byesMultiWeek: floor(raw.byesMultiWeek - credits.byesMultiWeek),
    byesConsecWeek: floor(raw.byesConsecWeek - credits.byesConsecWeek),
    byesConsecWeekSameDay: floor(
      raw.byesConsecWeekSameDay - credits.byesConsecWeekSameDay,
    ),
    byesAdjNight: floor(raw.byesAdjNight - credits.byesAdjNight),
  };
}

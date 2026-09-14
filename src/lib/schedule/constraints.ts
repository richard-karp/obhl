// ⚠️ Stores a date or time, never a solver index: an index shifts when a skip date or ice time
// is added. Resolved at generation; RUNBOOK.md, _Schedule generator_.

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

/** ⚠️ Loose on purpose (`jsonb`): an old or hand-written row must resolve unmet, never throw. */
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

export type ResolvedConstraint = {
  source: ScheduleConstraint;
  /** Why it couldn't resolve, or null; an unresolved one reaches no phase and reports unmet. */
  unresolved: string | null;
  /** Team index into `teamIds`, or −1 when the team is no longer enrolled. */
  team: number;
  forced: { team: number; night: number; plays: boolean }[];
  byeInWeek: { team: number; week: number } | null;
  slotPin: { team: number; night: number; slot: number } | null;
  bias: SlotBias | null;
  nights: number[];
};

export type ResolvedConstraints = {
  items: ResolvedConstraint[];
  forced: { team: number; night: number; plays: boolean }[];
  byeInWeek: { team: number; week: number }[];
  slotPins: { team: number; night: number; slot: number }[];
  biases: SlotBias[];
  /** True when nothing reaches a solver phase. ⚠️ Not "no constraints": an all-unresolved set
   *  is `empty` with items, so reporting gates on `items.length`. */
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

/** ⚠️ Never throws and never returns a partial index: whatever doesn't resolve is dropped
 *  from every phase list. */
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
        // ⛔ `slot_on` implies `play_on`: unforced, Phase P may bye the team, and the pin
        // silently becomes unsatisfiable.
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
  const biases = items.flatMap((i) =>
    !i.unresolved && i.bias ? [i.bias] : [],
  );
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

/** Direct contradictions, checked before arithmetic so the message names both requests. */
export function constraintConflicts(
  resolved: ResolvedConstraints,
  nameOf: (teamId: string) => string,
): string[] {
  const out: string[] = [];
  const label = (i: ResolvedConstraint) =>
    describeConstraint(i.source, nameOf(i.source.teamId));

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

  const bySlot = new Map<string, ResolvedConstraint[]>();
  const byTeamNight = new Map<string, ResolvedConstraint[]>();
  // ⛔ Identical pins are one instruction: nothing stops a duplicate row (a double-click), and
  // counting it as a conflict made `generateSchedule` refuse the whole season.
  const seenPin = new Set<string>();
  for (const item of resolved.items) {
    if (item.unresolved || !item.slotPin) continue;
    const { team, night, slot } = item.slotPin;
    const identity = `${team}:${night}:${slot}`;
    if (seenPin.has(identity)) continue;
    seenPin.add(identity);
    const sk = `${night}:${slot}`;
    (bySlot.get(sk) ?? bySlot.set(sk, []).get(sk)!).push(item);
    const tk = `${team}:${night}`;
    (byTeamNight.get(tk) ?? byTeamNight.set(tk, []).get(tk)!).push(item);
  }
  for (const group of bySlot.values()) {
    // ⛔ Two is not a conflict: two teams on one ice time may be playing each other, which
    // nobody can know before Phase M. Only three cannot share one sheet.
    if (group.length < 3) continue;
    out.push(
      `“${label(group[0])}”, “${label(group[1])}” and ${group.length - 2} other request${group.length === 3 ? "" : "s"} all claim the same ice time that night — one sheet of ice seats two teams.`,
    );
  }
  for (const group of byTeamNight.values()) {
    if (group.length < 2) continue;
    if (new Set(group.map((i) => i.slotPin!.slot)).size < 2) continue;
    out.push(
      `“${label(group[0])}” and “${label(group[1])}” pin the same team to two ice times on one night.`,
    );
  }
  return dedupe(out);
}

const dedupe = (xs: string[]) => [...new Set(xs)];

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

  // ⛔ A `bye_in_week` on a week with no bye to give: the season budget can't see it, and
  // unrefused it only reports unmet with the generic `NO_PLAN_REASON`.
  // ⛔ It costs a draft: `generateSchedule` treats this as fatal, so in COUNT mode the manager
  // gets this refusal, not a draft that ignored the request (decided with the user).
  const nightsOfWeek = new Map<number, number[]>();
  weekOfNight.forEach((w, n) => {
    const list = nightsOfWeek.get(w);
    if (list) list.push(n);
    else nightsOfWeek.set(w, [n]);
  });
  for (let t = 0; t < T; t++) {
    const paidByForced = new Set([...byeNights[t]].map((n) => weekOfNight[n]));
    for (const w of byeWeeks[t]) {
      if (paidByForced.has(w)) continue;
      const inWeek = nightsOfWeek.get(w) ?? [];
      if (inWeek.length === 0) continue;
      if (inWeek.some((n) => T - 2 * (gamesPerNight[n] ?? 0) > 0)) continue;
      const seats =
        inWeek.length === 1
          ? "its only game night seats"
          : `all ${inWeek.length} of its game nights seat`;
      out.push(
        `${nameOf(teamIds[t])} is asked to bye in a week that has no bye to give — ${seats} every one of the ${T} teams. Drop that request or run fewer games that week.`,
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

/** ⛔ Two reasons: `plannerHonours` is usually false because Phase P returned null, not
 *  because it lost a rank-off, and naming a rank-off that never happened misleads. */
export const FALLBACK_PLANNER_REASON =
  "the fallback planner produced a better schedule overall, and it cannot honour constraints";

export const NO_PLAN_REASON =
  "the generator could not build a schedule that forces game nights on this calendar — try more game nights, or fewer games per team";

/** ⛔ Decided from the final placed games, never from what a phase was asked. When
 *  `plannerHonours` is false, bye and play kinds report unmet: a coincidence isn't compliance. */
export function evaluateConstraints(
  resolved: ResolvedConstraints,
  opts: {
    /** `plays[team][night]` — read off the placed games. */
    plays: boolean[][];
    /** The slot a team took on a night, or null when it byed. */
    slotOf: (team: number, night: number) => number | null;
    /** False when the winning plan came from a planner that cannot force cells. */
    plannerHonours: boolean;
    /**
    /** Did Phase P produce a plan? Separates "outranked" from "nothing to rank". */
    plannerRan?: boolean;
  },
): ConstraintOutcome[] {
  const { plays, slotOf, plannerHonours, plannerRan = true } = opts;
  /** ⛔ Ice times the night handed out, from placed games, not its ice-time list: slots run
   *  0…games−1, so counting sheets makes every early request unmet. */
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
    // ⛔ Only kinds that need Phase P short-circuit: `slot_bias` is readable off the placed
    // games whichever planner placed them.
    if (!plannerHonours && item.source.kind !== "slot_bias") {
      return {
        ...base,
        satisfied: false,
        reason: plannerRan ? FALLBACK_PLANNER_REASON : NO_PLAN_REASON,
      };
    }
    const t = item.team;
    const played = (n: number) => plays[t]?.[n] === true;
    switch (item.source.kind) {
      case "bye_on":
        return verdict(
          base,
          !played(item.nights[0]),
          "the team plays that night",
        );
      case "play_on":
        return verdict(
          base,
          played(item.nights[0]),
          "the team byes that night",
        );
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
        // ⛔ The midpoint comes from the ice available, per night, not the team's own slots:
        // a team given slot 0 every night has an observed max of 0, and `0 < 0` reads unmet.
        const mean = slots.reduce((a, b) => a + b, 0) / slots.length;
        const nightsPlayed = played1.filter((n) => slotOf(t, n) !== null);
        const midOf = (n: number) => (gamesOn(n) - 1) / 2;
        const expected =
          nightsPlayed.reduce((a, n) => a + midOf(n), 0) / nightsPlayed.length;
        // The best possible, for one-game nights where slot 0 is also the last: met by definition.
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

/** ⛔ Subtracted when presenting only: `byeRuleCost` and `buildMinAdjTable` stay untouched
 *  (Phase P's objective and admissible bound). RUNBOOK.md, _Schedule generator_.
 *  A breach is credited only when every bye in it is forced, so collateral stays visible. */
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
  for (const f of resolved.forced)
    if (!f.plays) forcedBye.add(`${f.team}:${f.night}`);
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

/** Bye metrics as a manager reads them. One function, so screen and test can't drift. */
export function presentSpacing<T extends ByeCredits>(
  raw: T,
  credits: ByeCredits,
): T {
  // ⚠️ Floored at zero: credits count every enrolled team, `spacingReport` only teams with
  // games, so an unplaced constrained team would print a negative bye count.
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

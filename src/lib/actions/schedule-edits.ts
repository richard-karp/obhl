"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireLeagueRole } from "@/lib/auth/guards";
import { leagueOfGame } from "@/lib/league/of-entity";
import { logAudit } from "@/lib/audit";
import { leagueDateKey, leagueOffset } from "@/lib/format";
import { countsFor, preserved } from "@/lib/schedule/balance";
import { editable, legalAfter, type GuardRow } from "@/lib/schedule/editGuards";
import { candidatesFor, swap } from "@/lib/schedule/replacePlan";
import { writeGames } from "@/lib/schedule/writeGames";
import type { GameWrite } from "@/lib/schedule/gameWrites";

// ⛔ Every edit is a trade: games per team and per night never change, so no replace-a-team or
// move-to-another-night primitive may exist. Soft goals are left as the manager left them.

type Admin = ReturnType<typeof createAdminClient>;

export type EditResult = { ok: true } | { ok: false; message: string };

/** Rows an edit reasons about, plus the goals the guards need. */
const ROW_COLS =
  "id, season_id, is_draft, status, scheduled_at, home_team_id, away_team_id, label, home_goals, away_goals";

type SeasonRow = GuardRow & {
  season_id: string;
  is_draft: boolean;
  label: string | null;
};

// Statuses `writeGames` may rewrite. ⛔ `editable()` (editGuards.ts) refuses
// every other status first: widen both together, or this change does nothing.
const EDITABLE_STATUSES = ["scheduled"] as const;

/** Manager of the league this game belongs to, or the request dies here. */
async function managerOfGame(gameId: string) {
  return requireLeagueRole(
    () => leagueOfGame(gameId, createAdminClient()),
    "league_manager",
  );
}

// ⛔ One side of the season, never both: a season in "replace" mode holds a published schedule and
// a draft, and reading the union refuses every edit and offers cross-set trade partners.
async function seasonRows(
  admin: Admin,
  seasonId: string,
  isDraft: boolean,
): Promise<SeasonRow[]> {
  const { data, error } = await admin
    .from("games")
    .select(ROW_COLS)
    .eq("season_id", seasonId)
    .eq("is_draft", isDraft);
  if (error)
    throw new Error(`Could not read the season's games: ${error.message}`);
  return (data ?? []) as SeasonRow[];
}

// ⚠️ A failed read only logs: names are cosmetic, so it must not turn a legal edit into a refusal.
async function namesFor(admin: Admin, seasonId: string) {
  const { data, error } = await admin
    .from("season_teams")
    .select("teams(id, name)")
    .eq("season_id", seasonId);
  if (error) {
    console.error("namesFor: falling back to team ids in messages", error);
  }
  const map = new Map<string, string>();
  for (const r of (data ?? []) as {
    teams: { id: string; name: string } | null;
  }[]) {
    if (r.teams) map.set(r.teams.id, r.teams.name);
  }
  return (id: string) => map.get(id) ?? id;
}

// ⛔ `legalAfter` and `preserved` run for every primitive: trading dates alone can drop a team onto
// a night it already plays.
function refusal(
  rows: SeasonRow[],
  after: SeasonRow[],
  touched: SeasonRow[],
  nameOf: (id: string) => string,
): string | null {
  for (const r of touched) {
    const why = editable(r, nameOf);
    if (why) return why;
  }
  return (
    legalAfter(after, nameOf) ??
    preserved(countsFor(rows), countsFor(after), nameOf)
  );
}

/** One row's write, with `prev` and `next` naming the SAME columns. */
function writeFor(before: SeasonRow, after: SeasonRow): GameWrite {
  return {
    id: before.id,
    next: {
      home_team_id: after.home_team_id,
      away_team_id: after.away_team_id,
    },
    prev: {
      home_team_id: before.home_team_id,
      away_team_id: before.away_team_id,
    },
    expectScheduledAt: before.scheduled_at ?? "",
  };
}

function revalidateSchedule() {
  revalidatePath("/[league]/schedule", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
}

/* ------------------------------------------------------------ the primitives */

/** Two games trade a participant: "two teams agreed to switch" and the replace-a-team wizard. */
export async function exchangeTeams(input: {
  gameX: string;
  teamOutX: string;
  gameY: string;
  teamOutY: string;
}): Promise<EditResult> {
  const user = await managerOfGame(input.gameX);
  const admin = createAdminClient();

  const x0 = await oneRow(admin, input.gameX);
  if (!x0) return { ok: false, message: "That game no longer exists." };
  const y0 = await oneRow(admin, input.gameY);
  if (!y0) return { ok: false, message: "The other game no longer exists." };
  if (x0.season_id !== y0.season_id) {
    return { ok: false, message: "Both games have to be in the same season." };
  }
  if (x0.id === y0.id) {
    return { ok: false, message: "Pick two different games." };
  }
  if (x0.is_draft !== y0.is_draft) {
    return {
      ok: false,
      message:
        "One of those games is a draft and the other is published. A trade has to be within one or the other.",
    };
  }

  // ⛔ Check membership before swapping: `swap` returns a row unchanged for a team on neither side,
  // so bad ids write no-ops and audit a trade that never happened.
  const inGame = (r: SeasonRow, t: string) =>
    r.home_team_id === t || r.away_team_id === t;
  if (!inGame(x0, input.teamOutX) || !inGame(y0, input.teamOutY)) {
    return {
      ok: false,
      message: "One of those teams is not in the game named.",
    };
  }
  if (input.teamOutX === input.teamOutY) {
    return { ok: false, message: "A team cannot trade places with itself." };
  }

  const rows = await seasonRows(admin, x0.season_id, x0.is_draft);
  const nameOf = await namesFor(admin, x0.season_id);

  const after = rows.map((r) => {
    if (r.id === x0.id) return swapRow(r, input.teamOutX, input.teamOutY);
    if (r.id === y0.id) return swapRow(r, input.teamOutY, input.teamOutX);
    return r;
  });

  const why = refusal(rows, after, [x0, y0], nameOf);
  if (why) return { ok: false, message: why };

  const problem = await writeGames(
    admin,
    x0.season_id,
    user.id,
    "exchange_teams",
    [
      writeFor(
        x0,
        after.find((r) => r.id === x0.id)!,
      ),
      writeFor(
        y0,
        after.find((r) => r.id === y0.id)!,
      ),
    ],
    EDITABLE_STATUSES,
    x0.is_draft,
  );
  if (problem) return { ok: false, message: problem };

  await logAudit({
    user_id: user.id,
    action: "exchange_teams",
    entity_type: "game",
    entity_id: x0.id,
    old_data: { [x0.id]: teams(x0), [y0.id]: teams(y0) },
    new_data: {
      [x0.id]: teams(after.find((r) => r.id === x0.id)!),
      [y0.id]: teams(after.find((r) => r.id === y0.id)!),
    },
  });
  revalidateSchedule();
  return { ok: true };
}

/** Two games trade dates. Preserves games-per-night by construction. */
export async function exchangeSlots(input: {
  gameX: string;
  gameY: string;
}): Promise<EditResult> {
  const user = await managerOfGame(input.gameX);
  const admin = createAdminClient();

  const x0 = await oneRow(admin, input.gameX);
  const y0 = await oneRow(admin, input.gameY);
  if (!x0 || !y0) return { ok: false, message: "That game no longer exists." };
  if (x0.season_id !== y0.season_id) {
    return { ok: false, message: "Both games have to be in the same season." };
  }
  if (x0.id === y0.id)
    return { ok: false, message: "Pick two different games." };
  // ⛔ Same cross-set refusal as `exchangeTeams`: otherwise it fails as "the schedule changed",
  // which is not what happened. Give any new exchange this guard too.
  if (x0.is_draft !== y0.is_draft) {
    return {
      ok: false,
      message:
        "One of those games is a draft and the other is published. A trade has to be within one or the other.",
    };
  }
  if (!x0.scheduled_at || !y0.scheduled_at) {
    return {
      ok: false,
      message: "Both games need a date before they can trade one.",
    };
  }

  const rows = await seasonRows(admin, x0.season_id, x0.is_draft);
  const nameOf = await namesFor(admin, x0.season_id);

  const after = rows.map((r) => {
    if (r.id === x0.id) return { ...r, scheduled_at: y0.scheduled_at };
    if (r.id === y0.id) return { ...r, scheduled_at: x0.scheduled_at };
    return r;
  });

  const why = refusal(rows, after, [x0, y0], nameOf);
  if (why) return { ok: false, message: why };

  const problem = await writeGames(
    admin,
    x0.season_id,
    user.id,
    "exchange_slots",
    [
      {
        id: x0.id,
        next: { scheduled_at: y0.scheduled_at },
        prev: { scheduled_at: x0.scheduled_at },
        expectScheduledAt: x0.scheduled_at,
      },
      {
        id: y0.id,
        next: { scheduled_at: x0.scheduled_at },
        prev: { scheduled_at: y0.scheduled_at },
        expectScheduledAt: y0.scheduled_at,
      },
    ],
    EDITABLE_STATUSES,
    x0.is_draft,
  );
  if (problem) return { ok: false, message: problem };

  await logAudit({
    user_id: user.id,
    action: "exchange_slots",
    entity_type: "game",
    entity_id: x0.id,
    old_data: { [x0.id]: x0.scheduled_at, [y0.id]: y0.scheduled_at },
    new_data: { [x0.id]: y0.scheduled_at, [y0.id]: x0.scheduled_at },
  });
  revalidateSchedule();
  return { ok: true };
}

// ⛔ Within its own night only: moving to another night takes a game from one night and gives it
// to another, which only `exchangeSlots` may do.
export async function retimeGame(input: {
  gameId: string;
  /** "YYYY-MM-DDTHH:MM", league-local, as a datetime-local field gives it. */
  at: string;
}): Promise<EditResult> {
  const user = await managerOfGame(input.gameId);
  const admin = createAdminClient();

  const g0 = await oneRow(admin, input.gameId);
  if (!g0) return { ok: false, message: "That game no longer exists." };
  if (!g0.scheduled_at) {
    return { ok: false, message: "That game has no date to move within." };
  }

  // ⛔ Shape-check before `leagueOffset` and `leagueDateKey`: a bad string throws `RangeError`, an
  // uncaught server exception instead of a refusal.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.at)) {
    return { ok: false, message: "That is not a valid date and time." };
  }

  const nameOf = await namesFor(admin, g0.season_id);
  const why = editable(g0, nameOf);
  if (why) return { ok: false, message: why };

  const next = `${input.at}:00${leagueOffset(input.at)}`;
  if (leagueDateKey(next) !== leagueDateKey(g0.scheduled_at)) {
    return {
      ok: false,
      message:
        "A game can only be moved to another time on the same night. To move it to a different night, trade nights with another game.",
    };
  }

  const rows = await seasonRows(admin, g0.season_id, g0.is_draft);
  const after = rows.map((r) =>
    r.id === g0.id ? { ...r, scheduled_at: next } : r,
  );
  const refused = refusal(rows, after, [g0], nameOf);
  if (refused) return { ok: false, message: refused };

  const problem = await writeGames(
    admin,
    g0.season_id,
    user.id,
    "retime_game",
    [
      {
        id: g0.id,
        next: { scheduled_at: next },
        prev: { scheduled_at: g0.scheduled_at },
        expectScheduledAt: g0.scheduled_at,
      },
    ],
    EDITABLE_STATUSES,
    g0.is_draft,
  );
  if (problem) return { ok: false, message: problem };

  await logAudit({
    user_id: user.id,
    action: "retime_game",
    entity_type: "game",
    entity_id: g0.id,
    old_data: { scheduled_at: g0.scheduled_at },
    new_data: { scheduled_at: next },
  });
  revalidateSchedule();
  return { ok: true };
}

// Games where `teamIn` could hand its place back to `teamOut`. An empty list is the refusal: there
// is no unbalanced single-row fallback.
export async function replacementOptions(input: {
  gameId: string;
  teamOut: string;
  teamIn: string;
}): Promise<
  | { ok: true; games: { id: string; label: string }[] }
  | { ok: false; message: string }
> {
  await managerOfGame(input.gameId);
  const admin = createAdminClient();

  const g0 = await oneRow(admin, input.gameId);
  if (!g0) return { ok: false, message: "That game no longer exists." };

  const rows = await seasonRows(admin, g0.season_id, g0.is_draft);
  const nameOf = await namesFor(admin, g0.season_id);
  const found = candidatesFor(rows, input.gameId, input.teamOut, input.teamIn);

  if (found.length === 0) {
    return {
      ok: false,
      message: `${nameOf(input.teamIn)} has no game ${nameOf(input.teamOut)} could take in exchange, so this swap would leave the two teams on different numbers of games.`,
    };
  }

  return {
    ok: true,
    games: found.map((g) => ({
      id: g.id,
      label: `${nameOf(g.home_team_id)} v ${nameOf(g.away_team_id)} — ${
        g.scheduled_at ? leagueDateKey(g.scheduled_at) : "no date"
      }`,
    })),
  };
}

/* ----------------------------------------------------------------- plumbing */

// ⛔ A failed read throws rather than returning null: callers read null as "no longer exists",
// which a failed read cannot know.
async function oneRow(admin: Admin, id: string): Promise<SeasonRow | null> {
  const { data, error } = await admin
    .from("games")
    .select(ROW_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not read game ${id}: ${error.message}`);
  return (data as SeasonRow) ?? null;
}

const teams = (r: SeasonRow) => ({
  home_team_id: r.home_team_id,
  away_team_id: r.away_team_id,
});

/** `swap` from replacePlan, keeping the season columns this file carries. */
function swapRow(r: SeasonRow, from: string, to: string): SeasonRow {
  return { ...r, ...swap(r, from, to) };
}

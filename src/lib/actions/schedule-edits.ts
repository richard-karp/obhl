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

/**
 * Manual schedule edits — every one of them a TRADE.
 *
 * ⛔ THE CONSTRAINT THAT SHAPED THIS FILE, in the user's words: "Total games
 * played and games per night are non-negotiable. Those numbers always have to
 * be even" — even meaning EQUAL. Follow it through and the obvious operations
 * cannot exist: replacing a team leaves one side a game short forever, and
 * moving a game to another night robs the night it left. Only trades preserve
 * both counts, so there are exactly three primitives here and no fourth.
 *
 * ⚠️ These do NOT run the repair. A repair re-optimises the whole schedule
 * against its goals; these leave every soft goal — bye spacing, weekday
 * balance, ice-time share — exactly as the manager left it. Making the schedule
 * worse by those measures is an ALLOWED outcome: two captains agreed to the
 * swap, and the app's job is to keep the two hard numbers true, not to
 * re-impose its own preferences. See the design doc, 2026-09-07.
 *
 * ⛔ NO TRANSACTION. `writeGames` is compensation-only, so a runtime dying
 * between the two rows of an exchange leaves one written — publicly, as a game
 * with a duplicated team. The user was told twice and chose to ship before the
 * 2026-09-10 rebuild. The deferred `pg_advisory_xact_lock` RPC closes it, and
 * these three are its first customers.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type EditResult = { ok: true } | { ok: false; message: string };

/** Rows an edit reasons about, plus the goals the guards need. */
const ROW_COLS =
  "id, season_id, status, scheduled_at, home_team_id, away_team_id, label, home_goals, away_goals";

type SeasonRow = GuardRow & { season_id: string; label: string | null };

/**
 * Statuses a manual edit may rewrite.
 *
 * ⛔ WIDER THAN THE REST OF THE APP, ON PURPOSE. Generate, repair and the
 * one-off planner pass `writeGames` its default of `["scheduled"]`. The user
 * decided postponed and cancelled games stay editable — neither carries a
 * result — so these three primitives pass this instead. `final` is absent, and
 * `editable` separately refuses any row holding goals, so a game somebody has
 * started scoring is out of reach by two independent checks.
 */
const EDITABLE_STATUSES = ["scheduled", "postponed", "cancelled"] as const;

/** Manager of the league this game belongs to, or the request dies here. */
async function managerOfGame(gameId: string) {
  return requireLeagueRole(
    () => leagueOfGame(gameId, createAdminClient()),
    "league_manager",
  );
}

async function seasonRows(
  admin: Admin,
  seasonId: string,
): Promise<SeasonRow[]> {
  const { data, error } = await admin
    .from("games")
    .select(ROW_COLS)
    .eq("season_id", seasonId);
  if (error)
    throw new Error(`Could not read the season's games: ${error.message}`);
  return (data ?? []) as SeasonRow[];
}

/** Team id → name, for messages a manager can act on. */
async function namesFor(admin: Admin, seasonId: string) {
  const { data } = await admin
    .from("season_teams")
    .select("teams(id, name)")
    .eq("season_id", seasonId);
  const map = new Map<string, string>();
  for (const r of (data ?? []) as {
    teams: { id: string; name: string } | null;
  }[]) {
    if (r.teams) map.set(r.teams.id, r.teams.name);
  }
  return (id: string) => map.get(id) ?? id;
}

/**
 * The check every primitive runs before it writes anything.
 *
 * ⛔ `legalAfter` AND `preserved` RUN FOR ALL THREE, including the ones that do
 * not touch teams. Trading two dates can drop a team onto a night it already
 * plays without changing a single team column; a guard bound to "the operation
 * that changes teams" would leave that door open.
 */
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
    legalAfter(after, nameOf) ?? preserved(countsFor(rows), countsFor(after))
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
  revalidatePath("/[league]/schedule-builder", "page");
  revalidatePath("/[league]/seasons/[seasonId]", "page");
}

/* ------------------------------------------------------------ the primitives */

/**
 * Two games trade a participant. The write behind BOTH "two teams agreed to
 * switch" and the replace-a-team wizard.
 */
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

  const rows = await seasonRows(admin, x0.season_id);
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
  if (!x0.scheduled_at || !y0.scheduled_at) {
    return {
      ok: false,
      message: "Both games need a date before they can trade one.",
    };
  }

  const rows = await seasonRows(admin, x0.season_id);
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

/**
 * Move a game's time WITHIN its own night.
 *
 * ⛔ NOT A DATE CHANGE. Moving a game to a different night takes a game from one
 * night and gives it to another, which is exactly what the invariant forbids —
 * that is `exchangeSlots`. This only shuffles ice times inside an evening, which
 * changes no count at all.
 */
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

  const rows = await seasonRows(admin, g0.season_id);
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

/**
 * The games where `teamIn` could hand its place back to `teamOut`, so the
 * replace-a-team wizard can offer them.
 *
 * An empty list is the refusal — there is no unbalanced single-row fallback.
 */
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

  const rows = await seasonRows(admin, g0.season_id);
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

async function oneRow(admin: Admin, id: string): Promise<SeasonRow | null> {
  const { data } = await admin
    .from("games")
    .select(ROW_COLS)
    .eq("id", id)
    .maybeSingle();
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

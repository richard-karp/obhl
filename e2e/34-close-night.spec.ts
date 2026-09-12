/**
 * Path 34: the nightly sweep — `/api/cron/close-night`.
 *
 * ⛔ THIS FILE EXISTS BECAUSE UNIT TESTS STRUCTURALLY CANNOT COVER THIS ROUTE'S
 * WORST BUG. `finalizeGameById` was first called without a client, so every
 * statement inside ran as `anon`, and the result was not an error — it was three
 * silent wrongs at once: the games UPDATE matched ZERO rows and returned no
 * error (an RLS-refused UPDATE is not an error), `logAudit` wrote on the admin
 * client regardless so the log gained a `finalize_game` entry for a game that
 * was never finalized, and the roster read is gated to FINAL games for public
 * roles so the score would have recomputed to 0-0. A stubbed test asserts the
 * SHAPE of the call and is blind to WHICH client it is. Only a real request
 * against real RLS can tell you.
 *
 * ⛔ AND BECAUSE THE SCRIPT THAT USED TO BE THE ONLY CHECK WENT BLIND UNNOTICED.
 * `scripts/verify-close-night.mjs` covers exactly this, but nothing ran it — so
 * when the sweep gained its lower bound, the script's over-48h fixture fell out
 * of range, the sweep matched nothing, and its failure text blamed the
 * anon-client bug that was not there. It stayed broken until someone ran it by
 * hand. A check nobody runs is not a check. This one runs in the e2e job.
 *
 * ⚠️ EVERY FIXTURE IS DERIVED AT RUN TIME AND RESTORED. This file runs last,
 * after 05, 13 and 33 have scored and finalized games, so a hard-coded name or
 * date is a test that passes alone and fails in the suite. `afterEach` puts back
 * everything a test touched — INCLUDING the score columns, because
 * `finalizeGameById` recomputes `home_goals`, `away_goals` and `finalized_at`
 * and a restore that forgets them leaves an invented score in a shared database.
 */
import { test, expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// Matches `playwright.config.ts`'s `webServer.env`, which is what the server
// under test actually has.
const CRON_SECRET = process.env.CRON_SECRET ?? "e2e-cron-secret";

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

type GameState = {
  id: string;
  status: string;
  scheduled_at: string | null;
  home_goals: number | null;
  away_goals: number | null;
  finalized_at: string | null;
};

/** Everything a test changed, put back in `afterEach`. */
let restoreGame: GameState | null = null;
let restoreRoster: { id: string; goals: number | null } | null = null;

async function sweep(request: APIRequestContext, opts?: { auth?: boolean }) {
  return request.get("/api/cron/close-night", {
    headers:
      opts?.auth === false
        ? {}
        : { authorization: `Bearer ${CRON_SECRET}` },
    failOnStatusCode: false,
  });
}

/**
 * The window the route is actually using, read from the route itself.
 *
 * ⛔ NOT RECOMPUTED HERE. A copy of `nightWindow`'s date arithmetic in the test
 * would be free to drift from the code under test, and would then agree with
 * itself while production was wrong — which is the whole failure this file is
 * meant to catch. The route reports the window it swept; that is the one
 * definition, and asking for it is also a live check that the route answers at
 * all.
 */
async function window(request: APIRequestContext) {
  const res = await sweep(request);
  expect(
    res.status(),
    "the sweep refused an authorized request. If this is 401, the dev server " +
      "was started without CRON_SECRET — `reuseExistingServer` will reuse a " +
      "server from before playwright.config.ts set it. Restart it.",
  ).toBe(200);
  const body = await res.json();
  expect(body.from, "the route must report the window it swept").toBeTruthy();
  expect(body.to).toBeTruthy();
  // ⚠️ This probe is a REAL sweep, not a dry run. It should find nothing: the
  // seed dates games 120 days back and tonight, and every test here restores
  // what it touched. A non-zero count means something upstream left a game open
  // on last night's date, and this file would be building on top of a mutation
  // it cannot undo.
  expect(
    body.closed,
    "the probe closed a game — something left one open on last night's date",
  ).toBe(0);
  return body as { from: string; to: string };
}

/** A finished past game, borrowed and put back. Never one of tonight's. */
async function borrowGame(before: string): Promise<GameState & { home_team_id: string }> {
  const db = admin();
  const { data } = await db
    .from("games")
    .select(
      "id, status, scheduled_at, home_goals, away_goals, finalized_at, home_team_id",
    )
    .eq("is_draft", false)
    .lt("scheduled_at", before)
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .single();
  expect(data, "no past game to borrow — reseed").toBeTruthy();
  restoreGame = {
    id: data!.id,
    status: data!.status,
    scheduled_at: data!.scheduled_at,
    home_goals: data!.home_goals,
    away_goals: data!.away_goals,
    finalized_at: data!.finalized_at,
  };
  return data!;
}

test.afterEach(async () => {
  const db = admin();
  if (restoreRoster) {
    await db
      .from("game_rosters")
      .update({ goals: restoreRoster.goals })
      .eq("id", restoreRoster.id);
    restoreRoster = null;
  }
  if (restoreGame) {
    const { id, ...cols } = restoreGame;
    await db.from("games").update(cols).eq("id", id);
    restoreGame = null;
  }
});

test.describe("Closing the night", () => {
  test("refuses a request with no secret, and changes nothing", async ({
    request,
  }) => {
    const { from } = await window(request);
    const game = await borrowGame(from);
    const db = admin();
    await db
      .from("games")
      .update({ status: "in_progress", scheduled_at: hoursInto(from, 19) })
      .eq("id", game.id);

    const res = await sweep(request, { auth: false });
    expect(res.status()).toBe(401);

    const { data: after } = await db
      .from("games")
      .select("status")
      .eq("id", game.id)
      .single();
    expect(
      after!.status,
      "a refused request still closed the game",
    ).toBe("in_progress");
  });

  test("closes a game left open last night, with the roster's score and no actor", async ({
    request,
  }) => {
    const { from } = await window(request);
    const game = await borrowGame(from);
    const db = admin();

    // ⚠️ THE EXPECTED SCORE IS THE SUM OF THE ROSTER, NOT A MAGIC NUMBER. The
    // fixture's other players already have goals; asserting the one value we
    // wrote fails against any seed but the one it was written for.
    const { data: roster } = await db
      .from("game_rosters")
      .select("id, goals")
      .eq("game_id", game.id)
      .eq("team_id", game.home_team_id);
    expect(roster?.length, "borrowed game has no roster rows").toBeTruthy();
    restoreRoster = { id: roster![0].id, goals: roster![0].goals };
    const expected = roster!.reduce(
      (n, r) => n + (r.id === roster![0].id ? 3 : (r.goals ?? 0)),
      0,
    );

    await db
      .from("games")
      .update({ status: "in_progress", scheduled_at: hoursInto(from, 19) })
      .eq("id", game.id);
    await db
      .from("game_rosters")
      .update({ goals: 3 })
      .eq("id", roster![0].id);

    const res = await sweep(request);
    expect(res.status()).toBe(200);
    expect((await res.json()).closed).toBe(1);

    const { data: after } = await db
      .from("games")
      .select("status, home_goals")
      .eq("id", game.id)
      .single();
    // ⛔ THIS PAIR IS THE ANON-CLIENT DETECTOR. Running unprivileged, the UPDATE
    // matches no rows and reports success, so the status stays `in_progress`
    // while the route says it closed one; and the roster read comes back empty,
    // so the score lands 0 instead of the sum.
    expect(
      after!.status,
      "the route reported success but the game is still open — the UPDATE " +
        "matched no rows, which means it ran as anon",
    ).toBe("final");
    expect(
      after!.home_goals,
      "a 0 here means the roster read came back empty — it ran unprivileged",
    ).toBe(expected);

    // A sweep is not a person. `audit_log.user_id` is nullable and the audit
    // page renders a null actor; attributing this to the last scorekeeper would
    // be a lie in the one record that exists to say who did what.
    const { data: entry } = await db
      .from("audit_log")
      .select("user_id")
      .eq("entity_id", game.id)
      .eq("action", "finalize_game")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(entry, "no finalize_game audit entry").toBeTruthy();
    expect(entry!.user_id, "a sweep must file under no actor").toBeNull();
  });

  test("leaves a game reopened on an EARLIER night alone", async ({
    request,
  }) => {
    // ⛔ THE LOWER BOUND, TESTED WHERE IT ACTUALLY RUNS. `close-night.test.ts`
    // pins the window arithmetic; this pins that the QUERY uses it. Unbounded,
    // the sweep selected every `in_progress` game ever recorded — and
    // `reopenGameById` puts a PAST-dated game back into exactly that state, from
    // the scoresheet's Reopen button and from `audit.ts`'s revert of a wrong
    // finalize. A manager who corrected a mistaken finalize would have found it
    // re-finalized by the next 06:00 sweep, attributed to nobody. The app's only
    // undo would have survived less than a day.
    const { from } = await window(request);
    const game = await borrowGame(from);
    const db = admin();
    // One night EARLIER than the window: the shape of a game reopened days later.
    await db
      .from("games")
      .update({ status: "in_progress", scheduled_at: hoursInto(from, -5) })
      .eq("id", game.id);

    const res = await sweep(request);
    expect(res.status()).toBe(200);
    expect((await res.json()).closed).toBe(0);

    const { data: after } = await db
      .from("games")
      .select("status")
      .eq("id", game.id)
      .single();
    expect(
      after!.status,
      "the sweep re-finalized a game from an earlier night — the lower bound " +
        "is gone, and with it the app's only undo for a bad finalize",
    ).toBe("in_progress");
  });
});

/** `hours` after the start of the swept night, as a UTC instant. */
function hoursInto(from: string, hours: number): string {
  return new Date(new Date(from).getTime() + hours * 36e5).toISOString();
}

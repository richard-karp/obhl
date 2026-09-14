/** Game night: scoring and finalizing, lineups and goalies, the scorekeeper's page, and the nightly sweep. */
/**
 * Paths 10–11: Score a game and game management.
 */
import { test, expect } from "@playwright/test";
import type { Page, APIRequestContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

type Role =
  | "Manager"
  | "Scorekeeper"
  | "Captain"
  | "One-league mgr"
  | "One-league scorer"
  | "No-league mgr"
  | "Commissioner"
  | "Deputy";

/** Dev-panel sign-in. A scorekeeper lands on `/tonight`, everyone else on the picker. */
async function signInAs(page: Page, role: Role, then?: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: role, exact: true }).click();
  await page.waitForURL(
    role === "Scorekeeper" || role === "One-league scorer" ? "/tonight" : "/",
  );
  if (then) await page.goto(then);
}

// ── Path 10: Score a game ───────────────────────────────────────────────────

test.describe("Path 10 — Score a game end-to-end", () => {
  test("dress players, record a goal, finalize, verify on public schedule", async ({
    page,
  }) => {
    await signInAs(page, "Scorekeeper", "/obhl/dashboard");
    await page.goto("/obhl/schedule");

    // Open first scheduled game
    // The scorekeeper's game list is the public schedule now, with a
    // button per row for whoever may open a scoresheet.
    await page
      .getByRole("link", { name: "Score", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // Dress all players for away team
    const lineupForms = page.locator("form").filter({
      has: page.locator('input[name="player_ids"]'),
    });
    const awayBoxes = lineupForms.first().locator('input[type="checkbox"]');
    for (let i = 0; i < (await awayBoxes.count()); i++) {
      await awayBoxes.nth(i).check();
    }
    await lineupForms
      .first()
      .getByRole("button", { name: "Save lineup" })
      .click();
    await page.waitForLoadState("networkidle");

    // Dress all players for home team
    const homeBoxes = lineupForms.last().locator('input[type="checkbox"]');
    for (let i = 0; i < (await homeBoxes.count()); i++) {
      await homeBoxes.nth(i).check();
    }
    await lineupForms
      .last()
      .getByRole("button", { name: "Save lineup" })
      .click();
    await page.waitForLoadState("networkidle");

    // Record one goal using the aria-labeled + button
    await page.getByRole("button", { name: "Add goals" }).first().click();
    await page.waitForLoadState("networkidle");

    const scoresheet = page.url();

    // ── Ported from scripts/verify-scoring.mjs: a finalize must MOVE the
    // standings and the stats. Deltas, because the seed already has final
    // games; read now, because every view counts final games only.
    const db = admin();
    const gameId = new URL(scoresheet).pathname.split("/")[3];
    const { data: game } = await db
      .from("games")
      .select("season_id, home_team_id, away_team_id")
      .eq("id", gameId)
      .single();
    const { data: season } = await db
      .from("seasons")
      .select("point_system")
      .eq("id", game!.season_id)
      .single();
    const points = season!.point_system as { win: number; loss: number };
    const readLines = async () =>
      (
        await db
          .from("game_rosters")
          .select("player_id, team_id, goals")
          .eq("game_id", gameId)
      ).data ?? [];
    // A server action is a fetch, not a navigation: the `networkidle` above
    // already returned once for this page, so it resolves at once here too
    // and does not wait for THIS click's request to even be sent. Poll
    // instead of reading once.
    await expect
      .poll(async () => (await readLines()).filter((r) => (r.goals ?? 0) > 0), {
        message: "exactly one player holds the one goal recorded above",
      })
      .toHaveLength(1);
    const lines = await readLines();
    const scored = lines.filter((r) => (r.goals ?? 0) > 0);
    const scorer = scored[0];
    const bench = lines.find(
      (r) => r.team_id === scorer.team_id && r.player_id !== scorer.player_id,
    )!;
    const loserTeam =
      scorer.team_id === game!.home_team_id
        ? game!.away_team_id
        : game!.home_team_id;
    const standing = async (teamId: string) => {
      const { data } = await db
        .from("v_standings_raw")
        .select("gp, points")
        .eq("season_id", game!.season_id)
        .eq("team_id", teamId)
        .single();
      return data!;
    };
    const skater = async (playerId: string, teamId: string) => {
      const { data } = await db
        .from("v_skater_stats")
        .select("gp, g")
        .eq("season_id", game!.season_id)
        .eq("player_id", playerId)
        .eq("team_id", teamId)
        .maybeSingle();
      return data ?? { gp: 0, g: 0 };
    };
    const winnerBefore = await standing(scorer.team_id);
    const loserBefore = await standing(loserTeam);
    const scorerBefore = await skater(scorer.player_id, scorer.team_id);
    const benchBefore = await skater(bench.player_id, bench.team_id);

    // ⛔ THE FIRST PRESS IS REFUSED, AND THAT IS THE TEST. Nothing above this
    // line picks a goalie — which is exactly how the maintainer's first three
    // production games were entered, four of six sides with no goalie of
    // record and no warning of any kind. `finalizeGame` now bounces a sheet
    // that is missing a lineup or a goalie back to itself with `?incomplete=1`
    // rather than writing it.
    await page.getByRole("button", { name: "Complete game" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/incomplete=1/);

    // ⚠️ SCOPED. Next's route announcer is also `role="alert"`, so a bare
    // `getByRole("alert")` matches two elements and fails on strict mode.
    const warning = page
      .locator("[role=alert]")
      .filter({ hasText: "not finished being entered" });
    await expect(warning).toBeVisible();
    // Named by team, not a general "something is wrong" — the whole point is
    // that the scorekeeper can see what to go and fix.
    await expect(warning.getByRole("listitem").first()).toContainText(
      "no goalie recorded",
    );
    // ⛔ AND THE GAME IS STILL NOT FINAL. Without this the test would pass on a
    // gate that warned and wrote anyway. ⚠️ Asserted as the ABSENCE of Final
    // rather than the presence of "Scheduled": recording a goal above bumps
    // the game to `in_progress`, so naming the status is naming the wrong one.
    await expect(page.getByText("Final")).toHaveCount(0);

    // The second press carries `confirm=1` and goes through.
    await page.getByRole("button", { name: "Complete anyway" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Final").first()).toBeVisible();

    const winnerAfter = await standing(scorer.team_id);
    const loserAfter = await standing(loserTeam);
    expect(winnerAfter.gp, "the scoring side's GP").toBe(winnerBefore.gp + 1);
    expect(loserAfter.gp, "the other side's GP").toBe(loserBefore.gp + 1);
    expect(winnerAfter.points, "a 1-0 win's points").toBe(
      winnerBefore.points + points.win,
    );
    expect(loserAfter.points, "a regulation loss's points").toBe(
      loserBefore.points + points.loss,
    );
    const scorerAfter = await skater(scorer.player_id, scorer.team_id);
    expect(scorerAfter.g, "the scorer's goals").toBe(scorerBefore.g + 1);
    expect(scorerAfter.gp).toBe(scorerBefore.gp + 1);
    const benchAfter = await skater(bench.player_id, bench.team_id);
    expect(benchAfter.gp, "dressed but did not score: GP still counts").toBe(
      benchBefore.gp + 1,
    );
    expect(benchAfter.g).toBe(benchBefore.g);

    // ⛔ THE FINALIZED GAME, NOT ANY GAME. This asserted that *some*
    // `a[href^="/obhl/games/"]` was visible on the schedule. Only a final game
    // gets that link (`game-row.tsx`), so it was not vacuous — but the seed
    // finalizes three rounds, so it was satisfied by any of them and would
    // have passed with this test's own game still unscored. Name the id.
    const id = new URL(scoresheet).pathname.split("/")[3];
    await page.goto("/obhl/schedule?view=results");
    await expect(page.locator(`a[href="/obhl/games/${id}"]`)).toHaveCount(1);
  });
});

// ── Path 11: Game management ────────────────────────────────────────────────

test.describe("Path 11 — Game management", () => {
  test("cancel a scheduled game and restore it", async ({ page }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto("/obhl/schedule");

    // The scorekeeper's game list is the public schedule now, with a
    // button per row for whoever may open a scoresheet.
    await page.getByRole("link", { name: "Score", exact: true }).last().click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    await page.getByRole("button", { name: "Cancel game" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Cancelled").first()).toBeVisible();
    const scoresheet = page.url();

    // ⛔ The game has to still be FINDABLE. Merging the scorekeeper's list into
    // the public schedule dropped cancelled games out of both of its groups —
    // not upcoming, not final — so the only route to "Restore to scheduled" was
    // a URL you had to already have. This test used to restore from the page it
    // was already on and would not have noticed.
    await page.goto("/obhl/schedule");
    const cancelledSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Cancelled" }) });
    await expect(cancelledSection).toBeVisible();
    const href = new URL(scoresheet).pathname;
    const listed = cancelledSection.locator(`a[href="${href}"]`);
    await expect(listed).toHaveCount(1);
    await listed.click();

    await page.getByRole("button", { name: "Restore to scheduled" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Scheduled").first()).toBeVisible();

    // ...and it leaves again once restored.
    //
    // ⛔ THIS GAME LEAVES THE SECTION; THE SECTION DOES NOT LEAVE THE PAGE.
    // This asserted the "Cancelled" heading was absent, which was only ever a
    // proxy — true because the seed had no cancelled game of its own, so the
    // section had exactly one occupant and vanished with it. The seed now
    // carries a standing cancelled fixture (there was previously no coverage
    // of that section at all), so the heading correctly stays.
    //
    // ⚠️ AND NOT A PAGE-WIDE CHECK EITHER: restored means `scheduled`, so this
    // game's Score link reappears under Upcoming. Scoped to the section.
    await page.goto("/obhl/schedule");
    await expect(cancelledSection.locator(`a[href="${href}"]`)).toHaveCount(0);
  });

  test("a visitor is not shown cancelled games", async ({ page, browser }) => {
    // ⚠️ CONTROLLED. A first version asserted the heading was absent on a fresh
    // context — and at the time the seed had no cancelled game, so it passed
    // whether or not the gate worked. There has to BE one for the absence to
    // mean anything. The seed now carries a standing cancelled fixture too, so
    // this test's own cancellation is belt-and-braces rather than the only
    // thing making the assertion meaningful — but it stays, because the test
    // should not depend on a fixture it does not create.
    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto("/obhl/schedule");
    await page.getByRole("link", { name: "Score", exact: true }).last().click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);
    // Held so the restore below does not have to find a link named "Manage" on a
    // page whose header also has one.
    const scoresheet = page.url();
    await page.getByRole("button", { name: "Cancel game" }).click();
    await page.waitForLoadState("networkidle");

    try {
      // The manager sees it...
      await page.goto("/obhl/schedule");
      await expect(
        page.getByRole("heading", { name: "Cancelled" }),
      ).toBeVisible();

      // ...and an anonymous visitor, on the same schedule, does not.
      const anon = await browser.newContext();
      const anonPage = await anon.newPage();
      await anonPage.goto("/obhl/schedule");
      await expect(
        anonPage.getByRole("heading", { name: "Cancelled" }),
      ).toHaveCount(0);
      await anon.close();
    } finally {
      await page.goto(scoresheet);
      await page.getByRole("button", { name: "Restore to scheduled" }).click();
      await page.waitForLoadState("networkidle");
    }
  });

  test("postpone a game and restore it", async ({ page }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto("/obhl/schedule");

    // The scorekeeper's game list is the public schedule now, with a
    // button per row for whoever may open a scoresheet.
    await page.getByRole("link", { name: "Score", exact: true }).last().click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // ⛔ RESTORED IN `finally`. `.last()` now resolves to one of TONIGHT's games
    // — the only ones a scorekeeper can open — and postponing nulls
    // `scheduled_at` (`0025`). A failure between the two clicks would leave that
    // game undated forever, taking it off `/tonight` and surfacing later
    // as an unrelated count mismatch in `05-scoring-night`. The sibling test
    // above already guards its cancel this way.
    try {
      await page.getByRole("button", { name: "Postpone" }).click();
      await page.waitForLoadState("networkidle");
      await expect(page.getByText("Postponed").first()).toBeVisible();
    } finally {
      await page.getByRole("button", { name: "Restore to scheduled" }).click();
      await page.waitForLoadState("networkidle");
    }
  });
});

/**
 * Path 18: Captain lineup — captain can save their team's dressed roster
 * on the scoresheet (extends the access check in 09-access which only verifies
 * the form exists).
 */
test.describe("Path 18 — Captain lineup save", () => {
  test("captain can check players and save lineup on their team's game", async ({
    page,
  }) => {
    await signInAs(page, "Captain", "/obhl/dashboard");

    // Dashboard shows upcoming games with "Set lineup" links
    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await expect(gameLink).toBeVisible();
    await gameLink.click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // Captain sees exactly one lineup form (their team only)
    const lineupForm = page
      .locator("form")
      .filter({ has: page.locator('input[name="player_ids"]') });
    await expect(lineupForm).toHaveCount(1);

    // Check all available players
    const checkboxes = lineupForm.locator('input[type="checkbox"]');
    const count = await checkboxes.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await checkboxes.nth(i).check();
    }

    await lineupForm.getByRole("button", { name: "Save lineup" }).click();
    await page.waitForLoadState("networkidle");

    // After save the page re-renders; the first checkbox should remain checked
    // (server-side dressed=true) confirming the save persisted
    const firstBox = page
      .locator("form")
      .filter({ has: page.locator('input[name="player_ids"]') })
      .locator('input[type="checkbox"]')
      .first();
    await expect(firstBox).toBeChecked();
  });
});

/**
 * Paths 19–21: Goalie management — buttons on score page, default goalie on
 * roster page, and captain permission to set goalie.
 */

/**
 * A Sharks game still to be played, on the given weekday in the league zone.
 *
 * ⛔ `scheduled`, NOT ANY GAME. A finalized game already has a goalie of
 * record, and the board shows THAT instead of the suggestion — so a test that
 * grabbed a played game would assert the seed's scoring, not the rule.
 */
async function sharksGameOn(weekday: number): Promise<string> {
  const db = admin();
  const { data: team } = await db
    .from("teams")
    .select("id")
    .eq("slug", "sharks")
    .limit(1)
    .single();
  // ⛔ SCOPED TO THE ACTIVE SEASON AND ORDERED. Without the season filter this
  // matched Sharks games in ANY season, including ones other specs create, and
  // without an order it took whichever row PostgREST returned first. It worked
  // only because `workers: 1` happens to run this file before those specs — a
  // dependency on suite order that nothing states.
  const { data: season } = await db
    .from("seasons")
    .select("id, leagues!inner(slug)")
    .eq("leagues.slug", "obhl")
    .eq("is_active", true)
    .single();
  const { data: games } = await db
    .from("games")
    .select("id, scheduled_at, home_team_id, away_team_id, status, is_draft")
    .eq("season_id", season!.id)
    .or(`home_team_id.eq.${team!.id},away_team_id.eq.${team!.id}`)
    .eq("status", "scheduled")
    .eq("is_draft", false)
    .order("scheduled_at", { ascending: true });
  const match = (games ?? []).find(
    (g) =>
      g.scheduled_at &&
      new Date(g.scheduled_at).toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
      }) === ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday],
  );
  if (!match) {
    throw new Error(
      `Seed has no scheduled Sharks game on weekday ${weekday} — check supabase/seed.sql, which pins rounds 4 (Tue) and 5 (Thu).`,
    );
  }
  return match.id;
}

// ── Path 20: the night's goalie ─────────────────────────────────────────────
//
// ⛔ THREE TESTS STOOD HERE AND ARE GONE (2026-09-11). They drove "Set Default"
// on a roster row and the "Goalie Schedule" card's per-weekday selects — both
// removed with `team_players.is_default_goalie` and the `team_goalie_days`
// table in `0049`. They could not be repointed, because there is no longer a
// goalie-specific control anywhere: a night is an ordinary roster field now,
// set beside jersey and position, and for a goalie it names that night's
// starter.
//
// ⚠️ REPLACED, NOT DROPPED. The rule itself is unit-tested in
// `src/lib/goalie/suggest.ts` — including the case no fixture reaches, two
// goalies sharing a night. What belongs HERE is the end-to-end pair the unit
// test cannot see: a two-goalie team pre-selecting a DIFFERENT goalie on each
// of its two nights, and a one-goalie team pre-selecting theirs on every
// night. Both need a fixture with two nights and a team with two goalies,
// which the seed gains in the next commit; the tests land with it.

test.describe("Path 20 — the night's goalie", () => {
  /**
   * ⛔ THE ONE THING THE UNIT TEST CANNOT SEE. `suggestGoalie` is exercised
   * directly in `src/lib/goalie/suggest.test.ts`; what it cannot prove is that
   * the scoresheet READS the same column the roster WRITES, on a real game,
   * through the real query. That is the shape of the two failures `AGENTS.md`
   * records — a feature that passed its whole suite while doing nothing.
   *
   * ⚠️ ASSERTED THROUGH `#8`, WHICH ONLY SHARKS HAVE. Every other seeded team's
   * goalie wears #1, so #1 appears twice on any scoresheet and cannot identify
   * a side; #8 is Sharks' second goalie and is pinned to Thursday. Whether it
   * carries the suggested styling therefore answers "did the night decide
   * this?" on its own.
   */
  const suggested = (page: Page, label: string) =>
    page.getByRole("button", { name: label, exact: true });

  test("a two-goalie team suggests a different goalie on each of its nights", async ({
    page,
  }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");

    // Thursday: #8's night, so #8 is the suggestion.
    await page.goto(`/obhl/games/${await sharksGameOn(4)}/score`);
    await expect(suggested(page, "#8")).toBeVisible();
    await expect(suggested(page, "#8")).toHaveClass(/bg-secondary/);

    // Tuesday: #1's night. #8 is still on the page — same roster — but must no
    // longer be the one offered, which is the whole point of the column.
    await page.goto(`/obhl/games/${await sharksGameOn(2)}/score`);
    await expect(suggested(page, "#8")).toBeVisible();
    await expect(suggested(page, "#8")).not.toHaveClass(/bg-secondary/);
  });

  test("a one-goalie team suggests its goalie whatever the night", async ({
    page,
  }) => {
    // ⚠️ THE RULE THAT REPLACED `is_default_goalie`. Every such flag in
    // production sat on a team with exactly one goalie, and this reproduces
    // them: the seed gives those teams a goalie with NO night at all, so
    // nothing but the one-goalie rule can be selecting them.
    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto(`/obhl/games/${await sharksGameOn(4)}/score`);

    // Exactly two buttons carry the suggestion — one per team. Sharks' is #8
    // by its night; the opponent's is theirs by being their only goalie.
    await expect(
      page
        .getByRole("button", { name: /^#\d+$/ })
        .and(page.locator(".bg-secondary")),
    ).toHaveCount(2);
  });
});

// ── Path 21: Captain sets goalie ────────────────────────────────────────────

test.describe("Path 21 — Captain sets goalie of record", () => {
  test("captain can click a goalie button and it persists", async ({
    page,
  }) => {
    await signInAs(page, "Captain", "/obhl/dashboard");

    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await gameLink.click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // Click the first goalie button
    const firstGoalieForm = page
      .locator("form")
      .filter({ has: page.locator('input[name="goalie_id"]') })
      .first();
    await firstGoalieForm.getByRole("button").click();
    await page.waitForLoadState("networkidle");

    // After save the page re-renders on the same URL with the goalie section still present
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);
    await expect(page.getByText("GOALIE").first()).toBeVisible();
  });

  test("captain does not see empty-net GA controls", async ({ page }) => {
    await signInAs(page, "Captain", "/obhl/dashboard");

    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await gameLink.click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // ⛔ THE LABEL, EXACTLY AS RENDERED. This read `"EMPTY-NET GA"` and passed on
    // a case-insensitive substring match — until the label was renamed to
    // "Empty-net goals", after which it matched nothing for ANY role and could
    // no longer fail — `getByText` with a string is a case-insensitive SUBSTRING
    // match, so it was real against the old label and vacuous against the new
    // one. Keep it pinned to the string the component actually renders.
    await expect(page.getByText("Empty-net goals")).toHaveCount(0);
  });
});

/**
 * The scorekeeper's night: `/tonight`, and the day restriction under it.
 *
 * ⛔ THE RESTRICTION IS APP-LEVEL ONLY, BY DECISION. RLS still lets a
 * scorekeeper's own session update any game in a league they belong to, bounded
 * by `0046`'s trigger to the scoring columns — so these tests are the ONLY thing
 * standing behind the rule, and there is no policy half to fall back on. That is
 * recorded in `ACCESS_CONTROL_HANDOFF.md`; it is repeated here because a reader
 * of this file might otherwise assume the usual guard-plus-policy pair.
 *
 * ⚠️ EVERY TEST HERE DEPENDS ON THE "TONIGHT" FIXTURE. `supabase/seed.sql` seeds
 * one night of three games on the LEAGUE-LOCAL date — the only fixture that is
 * ever today. Every other seeded game sits ~120 days back or ~14 days forward,
 * so without it a scorekeeper can open exactly zero games and this whole file
 * would pass while exercising nothing.
 */

/**
 * A published game that is NOT today — one of the seeded rounds ~120 days back.
 *
 * Read from the page rather than the database, and from the MANAGER's view of
 * the schedule, because a manager still sees a Score button on every row. That
 * is the point: the id is real and openable, so a scorekeeper being refused it
 * is the restriction working rather than a broken link.
 */
async function anOldGameId(page: Page): Promise<string> {
  // ⚠️ THE SIGN-IN IS LOAD-BEARING FOR THE CALLER. "a manager may still open
  // that same game" does not sign in itself; it relies on this.
  await signInAs(page, "Manager");

  // ⛔ READ FROM THE DATABASE, NOT SCRAPED OFF THE SCHEDULE PAGE. Two earlier
  // attempts narrowed the DOM scope — first to "the first link", then to the
  // last link under "Recent Results" — and both were wrong in the same way:
  // the page renders whichever season is ACTIVE, and specs 14 and 29 set their
  // own seasons active while they run. In the full suite this helper was handed
  // a page with no Recent Results section at all, so it failed on CI with
  // "element(s) not found" while passing in isolation.
  //
  // What the tests need is a game that is not TODAY, in a league the
  // scorekeeper works. That is a fact about the data, so ask the data. The
  // oldest non-draft obhl game is ~120 days back in the seed and nothing in the
  // suite moves it.
  const db = admin();
  const { data: league } = await db
    .from("leagues")
    .select("id")
    .eq("slug", "obhl")
    .single();
  const { data: game } = await db
    .from("games")
    .select("id, scheduled_at, seasons!inner(league_id)")
    .eq("seasons.league_id", league!.id)
    .eq("is_draft", false)
    .not("scheduled_at", "is", null)
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  expect(
    game,
    "no non-draft obhl game with a date — the fixture changed",
  ).not.toBeNull();

  // The premise, asserted rather than assumed: a game dated today would make
  // the refusal test assert a refusal that correctly does not happen.
  const day = new Date(game!.scheduled_at as string).toLocaleDateString(
    "en-CA",
    { timeZone: "America/New_York" },
  );
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  expect(day, "the oldest obhl game is TODAY — the fixture changed").not.toBe(
    today,
  );

  return game!.id;
}

test.describe("The scorekeeper's night", () => {
  test("lists tonight's games, each with a way into its scoresheet", async ({
    page,
  }) => {
    await signInAs(page, "Scorekeeper");

    // ⛔ THE INVARIANT, NOT A COUNT. An earlier version asserted exactly four
    // scoresheet links and was RIGHT about the fixture and WRONG as a test: those
    // games are a shared, consumable fixture, and by the time the full suite
    // reaches this file earlier specs have cancelled or postponed some of them
    // (a postponed game has `scheduled_at` nulled, so it leaves the night
    // entirely). It passed alone and failed in the suite — which is the worst
    // kind of test, since it accuses whatever changed last.
    //
    // What actually has to hold is: every row is TODAY, and both leagues this
    // account scores for are represented. Neither weakens with consumption.
    await expect(page.locator('a[href$="/score"]').first()).toBeVisible();
    await expect(page.getByText("Oceanview Beer Hockey League")).toBeVisible();
    await expect(page.getByText("Harbor Rec Hockey League")).toBeVisible();

    // ⛔ AND NOTHING FROM ANOTHER DAY — the assertion the count was standing in
    // for. If the day window ever widened to a season, other dates appear here.
    //
    // ⚠️ IT BINDS TO `data-testid="game-date"` BECAUSE THE FIRST VERSION BOUND TO
    // NOTHING. It used `locator("time, [class*='whitespace-nowrap']")` — there is
    // no `<time>` element anywhere in src/, and the nowrap class belongs to
    // buttons and badges — so the Set was always empty and `<= 1` always passed.
    // Written to replace a brittle count and vacuous from birth.
    const dates = await page.getByTestId("game-date").allInnerTexts();
    expect(dates.length, "no game rows rendered at all").toBeGreaterThan(0);
    expect(
      new Set(dates.map((d) => d.trim())).size,
      `expected one night, saw ${dates.join(" / ")}`,
    ).toBe(1);
  });

  test("a scorekeeper sees only the leagues they keep score for", async ({
    page,
  }) => {
    // The control for the test above. `single-league-scorer@` belongs to obhl
    // only, so the Harbor game seeded for tonight must NOT appear — otherwise
    // "cross-league" would just mean "every league", which is a leak rather than
    // a feature.
    await signInAs(page, "One-league scorer");

    // ⛔ THE SCOPING, NOT THE COUNT — same reasoning as above. What must hold is
    // that the OTHER league never appears for an account that does not score it.
    await expect(page.locator('a[href$="/score"]').first()).toBeVisible();
    await expect(page.getByText("Oceanview Beer Hockey League")).toBeVisible();
    await expect(page.getByText("Harbor Rec Hockey League")).toHaveCount(0);
  });

  test("a game that is not today is refused, and says where to go", async ({
    page,
  }) => {
    const oldGame = await anOldGameId(page);

    await signInAs(page, "Scorekeeper");
    await page.goto(`/obhl/games/${oldGame}/score`);

    // ⛔ Asserting the DESTINATION, not merely the absence of a scoresheet.
    // `toHaveURL` waits, so this does not race the redirect — and landing back
    // on their own page rather than the picker is the deliberate deviation from
    // every other guard in the app.
    await expect(page).toHaveURL("/tonight");
    await expect(page.getByRole("heading", { name: "Tonight" })).toBeVisible();
  });

  test("a manager may still open that same game", async ({ page }) => {
    // The control. Without it, the test above would pass just as well if the
    // game id were bad or the page were broken for everyone — which is exactly
    // how a refusal test comes to prove nothing.
    const oldGame = await anOldGameId(page);

    await page.goto(`/obhl/games/${oldGame}/score`);
    await expect(page).toHaveURL(`/obhl/games/${oldGame}/score`);
    await expect(
      page.getByRole("button", { name: "Save lineup" }).first(),
    ).toBeVisible();
  });

  test("picking a goalie dresses them, and a lineup save does not undress them", async ({
    page,
  }) => {
    // ⛔ THE PAIR. Goalies are no longer lineup checkboxes — `setGoalie` dresses
    // whoever is picked, and `setLineup` must exclude goalies from the removal it
    // reconciles. Both files say "the two changes only work as a pair" and
    // nothing tested the pair, which is exactly the shape of gap this repo's
    // "assert on what ships" rule is about: a regression that deletes the goalie
    // on every lineup save would be invisible to every other spec.
    await signInAs(page, "Scorekeeper");
    await page
      .getByRole("link", { name: "Score", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    const lineupForms = page.locator("form").filter({
      has: page.locator('input[name="player_ids"]'),
    });
    // Dress the skaters so the goalie section appears.
    for (const form of [lineupForms.first(), lineupForms.last()]) {
      const boxes = form.locator('input[type="checkbox"]');
      for (let i = 0; i < (await boxes.count()); i++)
        await boxes.nth(i).check();
      await form.getByRole("button", { name: "Save lineup" }).click();
      await page.waitForLoadState("networkidle");
    }

    // Pick a goalie of record.
    const goalieButtons = page
      .locator("form")
      .filter({ has: page.locator('input[name="goalie_id"]') })
      .first()
      .getByRole("button");
    await goalieButtons.first().click();
    await page.waitForLoadState("networkidle");

    // ⛔ THE ASSERTION IS ON THE DRESSED LINES, WHICH IS WHERE THE REGRESSION
    // WOULD SHOW. The first version counted lineup CHECKBOXES before and after —
    // but those come from `team_players` filtered to `position !== 'G'` and never
    // touch `game_rosters`, so the count was constant no matter what the save
    // did. It could not fail. Its companion assertion ("Empty-net goals" is
    // visible) was true from page load too.
    //
    // A dressed line exists per `game_rosters` row, so if a lineup save deletes
    // the goalie's row — the exact bug the paired change guards against — the
    // count here drops.
    const dressed = page.getByTestId("dressed-line");
    const dressedAfterGoalie = await dressed.count();
    expect(
      dressedAfterGoalie,
      "picking a goalie should dress them",
    ).toBeGreaterThan(0);

    // Save the lineup again. Before the paired fix this deleted the goalie's
    // roster row, because the form no longer submits them.
    await lineupForms
      .first()
      .getByRole("button", { name: "Save lineup" })
      .click();
    await page.waitForLoadState("networkidle");

    await expect(
      dressed,
      "a lineup save must not undress anyone — the goalie is not in the form",
    ).toHaveCount(dressedAfterGoalie);
  });

  test("a scoresheet gives the scorekeeper the minimal chrome and a way back", async ({
    page,
  }) => {
    await signInAs(page, "Scorekeeper");
    await page
      .getByRole("link", { name: "Score", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // ⛔ The site header and the staff row are BOTH gone for a scorekeeper —
    // `[league]/layout` swaps them for `ScorekeeperChrome`. What is left is the
    // way back to tonight, and nothing they cannot act on.
    await expect(page.getByRole("link", { name: /Tonight/ })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Staff tools" }),
    ).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "League" })).toHaveCount(
      0,
    );

    // #2: no account chrome a shared login should not have.
    await expect(page.getByRole("link", { name: "Password" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });
});

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
 * A script, since deleted, covered exactly this, but nothing ran it — so
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
test.describe("Closing the night", () => {
  // Matches `playwright.config.ts`'s `webServer.env`, which is what the server
  // under test actually has.
  const CRON_SECRET = process.env.CRON_SECRET ?? "e2e-cron-secret";

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

  /** `hours` after the start of the swept night, as a UTC instant. */
  function hoursInto(from: string, hours: number): string {
    return new Date(new Date(from).getTime() + hours * 36e5).toISOString();
  }
});

test.describe("Manage dashboard — games still open", () => {
  test("a past game left in progress is listed; a final one is not", async ({
    page,
  }) => {
    const db = admin();
    const { data: season } = await db
      .from("seasons")
      .select("id, leagues!inner(slug)")
      .eq("leagues.slug", "obhl")
      .eq("is_active", true)
      .single();
    const { data: sharks } = await db
      .from("teams")
      .select("id")
      .eq("slug", "sharks")
      .limit(1)
      .single();
    // Not a Sharks game: `sharksGameOn` consumes those. Round 4 is past in the seed.
    const { data: round4 } = await db
      .from("games")
      .select("id, home_team_id, away_team_id")
      .eq("season_id", season!.id)
      .eq("round", 4)
      .eq("status", "scheduled")
      .eq("is_draft", false)
      .order("scheduled_at", { ascending: true });
    const open = (round4 ?? []).find(
      (g) => g.home_team_id !== sharks!.id && g.away_team_id !== sharks!.id,
    );
    if (!open) {
      throw new Error(
        "Seed has no scheduled non-Sharks round-4 game — check supabase/seed.sql.",
      );
    }
    const { data: final } = await db
      .from("games")
      .select("id")
      .eq("season_id", season!.id)
      .eq("status", "final")
      .limit(1)
      .single();

    await db.from("games").update({ status: "in_progress" }).eq("id", open.id);
    try {
      await signInAs(page, "Manager");
      await page.goto("/obhl/dashboard");
      const card = page.getByRole("region", { name: "Games still open" });
      await expect(
        card.locator(`a[href="/obhl/games/${open.id}/score"]`),
      ).toHaveCount(1);
      await expect(
        card.locator(`a[href="/obhl/games/${final!.id}/score"]`),
      ).toHaveCount(0);
    } finally {
      await db.from("games").update({ status: "scheduled" }).eq("id", open.id);
    }
  });
});

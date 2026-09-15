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

test.describe("Path 10 — Score a game end-to-end", () => {
  test("dress players, record a goal, finalize, verify on public schedule", async ({
    page,
  }) => {
    await signInAs(page, "Scorekeeper", "/obhl/dashboard");
    await page.goto("/obhl/schedule");

    // Open the first scheduled game.
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

    // A finalize must MOVE the standings and stats. Deltas, because the seed already has final
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
    // Poll: a server action is a fetch, so `networkidle` already resolved for this page and does
    // not wait for this click's request.
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

    // ⛔ THE FIRST PRESS IS REFUSED, AND THAT IS THE TEST: no goalie was picked, and `finalizeGame`
    // bounces a sheet missing a lineup or a goalie back with `?incomplete=1` rather than writing it.
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
    // ⛔ AND THE GAME IS STILL NOT FINAL, or a gate that warned and wrote anyway passes. ⚠️ The absence
    // of Final, not "Scheduled": the goal above moved the game to `in_progress`.
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

    // ⛔ THE FINALIZED GAME, NOT ANY GAME: the seed finalizes three rounds, so any final game's link
    // would pass with this game still unscored. Name the id.
    const id = new URL(scoresheet).pathname.split("/")[3];
    await page.goto("/obhl/schedule?view=results");
    await expect(page.locator(`a[href="/obhl/games/${id}"]`)).toHaveCount(1);
  });
});

test.describe("Path 11 — Game management", () => {
  test("cancel a scheduled game and restore it", async ({ page }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto("/obhl/schedule");

    await page.getByRole("link", { name: "Score", exact: true }).last().click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    await page.getByRole("button", { name: "Cancel game" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Cancelled").first()).toBeVisible();
    const scoresheet = page.url();

    // ⛔ The cancelled game must still be FINDABLE on the schedule: its row is the only route to
    // "Restore to scheduled" without already having the URL.
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

    // ...and it leaves again once restored. ⛔ This game leaves; the section stays, for the seed's own
    // cancelled game. ⚠️ Scoped to the section: restored, its Score link is back under Upcoming.
    await page.goto("/obhl/schedule");
    await expect(cancelledSection.locator(`a[href="${href}"]`)).toHaveCount(0);
  });

  test("a visitor is not shown cancelled games", async ({ page, browser }) => {
    // ⚠️ Controlled: an absence means something only if a cancelled game exists, so the test makes its
    // own rather than depend on the seed's.
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

    await page.getByRole("link", { name: "Score", exact: true }).last().click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // ⛔ Restored in `finally`: `.last()` is one of tonight's games and postponing nulls `scheduled_at`,
    // so a failure would take a consumable fixture off `/tonight` (`RUNBOOK.md` → Seed and fixtures).
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

// ⛔ A `scheduled` Sharks game on a weekday: a finalized game shows its goalie of record instead of
// the suggestion, so the test would assert the seed's scoring, not the rule.
async function sharksGameOn(weekday: number): Promise<string> {
  const db = admin();
  const { data: team } = await db
    .from("teams")
    .select("id")
    .eq("slug", "sharks")
    .limit(1)
    .single();
  // ⛔ Scoped to the active season and ordered: otherwise it matches Sharks games in seasons other
  // specs create, in whatever order PostgREST returns.
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

test.describe("Path 20 — the night's goalie", () => {
  // ⛔ `suggestGoalie` is unit-tested; this checks the scoresheet READS the night the roster WRITES.
  // ⚠️ Through `#8`, Sharks' Thursday goalie: every other seeded goalie wears #1, which marks no side.
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
    // ⚠️ The seed gives one-goalie teams a goalie with NO night, so only the one-goalie rule can be
    // selecting them.
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

    // ⛔ The label exactly as rendered: `getByText` with a string is a case-insensitive substring, so a
    // renamed label leaves this matching nothing, for any role.
    await expect(page.getByText("Empty-net goals")).toHaveCount(0);
  });
});

// ⛔ The day restriction has no RLS half (`RUNBOOK.md` → Access control → Scorekeeper day rule), so
// these tests are all that stands behind it. ⚠️ They need the tonight fixture (Seed and fixtures).

async function anOldGameId(page: Page): Promise<string> {
  // ⚠️ THE SIGN-IN IS LOAD-BEARING FOR THE CALLER. "a manager may still open
  // that same game" does not sign in itself; it relies on this.
  await signInAs(page, "Manager");

  // ⛔ Read from the database, not scraped off the schedule page: the page renders the ACTIVE season,
  // which other specs change while they run.
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

    // ⛔ The invariant, never a count: the tonight rounds are consumable (`RUNBOOK.md` → Seed and
    // fixtures). Every row is today, and both leagues this account scores for appear.
    await expect(page.locator('a[href$="/score"]').first()).toBeVisible();
    await expect(page.getByText("Oceanview Beer Hockey League")).toBeVisible();
    await expect(page.getByText("Harbor Rec Hockey League")).toBeVisible();

    // ⛔ AND NOTHING FROM ANOTHER DAY. ⚠️ Bound to `data-testid="game-date"`, with a non-empty check:
    // a locator matching nothing gives an empty Set and passes.
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
    // The control for the test above: `single-league-scorer@` is obhl only, so Harbor's game must
    // not appear, or "cross-league" just means "every league".
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

    // ⛔ The DESTINATION, not merely no scoresheet: landing on their own page rather than the picker
    // is this guard's deliberate deviation from every other.
    await expect(page).toHaveURL("/tonight");
    await expect(page.getByRole("heading", { name: "Tonight" })).toBeVisible();
  });

  test("a manager may still open that same game", async ({ page }) => {
    // The control: without it, a bad game id or a page broken for everyone passes the test above.
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
    // ⛔ THE PAIR: `setGoalie` dresses whoever is picked, and `setLineup` must not remove goalies. A
    // lineup save that deletes the goalie would be invisible to every other spec.
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

    // ⛔ Count dressed lines (`game_rosters` rows), not lineup checkboxes: those exclude goalies and
    // never change. A lineup save that deletes the goalie's row drops this count.
    const dressed = page.getByTestId("dressed-line");
    const dressedAfterGoalie = await dressed.count();
    expect(
      dressedAfterGoalie,
      "picking a goalie should dress them",
    ).toBeGreaterThan(0);

    // Save the lineup again: the form does not submit goalies, so this must not delete their row.
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

    // ⛔ The site header and the staff row are BOTH gone: `[league]/layout` swaps them for
    // `ScorekeeperChrome`, leaving the way back to tonight.
    await expect(page.getByRole("link", { name: /Tonight/ })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Staff tools" }),
    ).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "League" })).toHaveCount(
      0,
    );

    // No account chrome a shared login should not have.
    await expect(page.getByRole("link", { name: "Password" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });
});

// ⛔ Real requests against real RLS: a stub can't see which client `finalizeGameById` runs on
// (`RUNBOOK.md` → Closing the night). ⚠️ Fixtures derived at run time; restore the score columns too.
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

  // ⛔ The window the route reports, never recomputed here: a copy of `nightWindow`'s arithmetic would
  // agree with itself while production was wrong.
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
    // ⚠️ A REAL sweep, not a dry run, so it should close nothing: a non-zero count means something left
    // a game open on last night's date.
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

    // ⚠️ THE EXPECTED SCORE IS THE SUM OF THE ROSTER, NOT A MAGIC NUMBER: the fixture's other
    // players already have goals, so the one value written here fails against any other seed.
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
    // ⛔ THE ANON-CLIENT DETECTOR: unprivileged, the UPDATE matches nothing so the status stays
    // `in_progress`, and the empty roster read lands 0 instead of the sum.
    expect(
      after!.status,
      "the route reported success but the game is still open — the UPDATE " +
        "matched no rows, which means it ran as anon",
    ).toBe("final");
    expect(
      after!.home_goals,
      "a 0 here means the roster read came back empty — it ran unprivileged",
    ).toBe(expected);

    // A sweep is not a person: attributing it to the last scorekeeper would be a lie in the record
    // that says who did what.
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
    // ⛔ The lower bound, where the query runs: `reopenGameById` puts a past game back in progress
    // (Reopen, audit revert), and an unbounded sweep re-finalizes it by morning.
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

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
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

type Role = "Manager" | "Scorekeeper" | "Captain" | "One-league scorer";

async function signedInAs(page: Page, role: Role) {
  await page.goto("/login");
  await page.getByRole("button", { name: role, exact: true }).click();
  // Both scorekeeper accounts land on their own page. "One-league scorer" does
  // not say "scorekeeper" anywhere, which is how the same change was missed in
  // `15-league-routing` — check the seeded ROLE, not the button label.
  await page.waitForURL(
    role === "Manager" || role === "Captain" ? "/" : "/tonight",
  );
}

/**
 * A published game that is NOT today — one of the seeded rounds ~120 days back.
 *
 * Read from the page rather than the database, and from the MANAGER's view of
 * the schedule, because a manager still sees a Score button on every row. That
 * is the point: the id is real and openable, so a scorekeeper being refused it
 * is the restriction working rather than a broken link.
 */
async function anOldGameId(page: Page): Promise<string> {
  await signedInAs(page, "Manager");
  await page.goto("/obhl/schedule");
  const hrefs = await page
    .locator('a[href*="/games/"][href$="/score"]')
    .evaluateAll((links) => links.map((l) => l.getAttribute("href") ?? ""));
  // ⚠️ DOM ORDER, which on this page is the *Upcoming* section — the seeded
  // rounds 4-5, which are `scheduled` yet ~85 days in the PAST. Not the results
  // section, as an earlier version of this comment claimed. Either would do:
  // what matters is only that the game is not today.
  const id = hrefs
    .map((h) => h.match(/\/games\/([^/]+)\/score$/)?.[1])
    .find((v): v is string => !!v);
  expect(
    id,
    "no scoresheet links on the manager's schedule — the fixture changed",
  ).toBeTruthy();
  return id!;
}

test.describe("The scorekeeper's night", () => {
  test("signing in lands on tonight, not the league picker", async ({
    page,
  }) => {
    // `signedInAs` already waits for the URL; this asserts the page rather than
    // just the address, so a redirect to a 404 would not pass.
    await signedInAs(page, "Scorekeeper");
    await expect(page.getByRole("heading", { name: "Tonight" })).toBeVisible();
  });

  test("lists tonight's games, each with a way into its scoresheet", async ({
    page,
  }) => {
    await signedInAs(page, "Scorekeeper");

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

    // ⛔ AND NOTHING FROM ANOTHER DAY. This is the assertion the count was really
    // standing in for: if the day window ever widened to a season, other dates
    // would appear here. Rows render "Thu, Sep 10"-style dates in the league
    // zone, so one distinct date means one night.
    const dates = await page
      .locator("time, [class*='whitespace-nowrap']")
      .allInnerTexts();
    const dayLabels = new Set(
      dates
        .map((t) => t.split("\n")[0].trim())
        .filter((t) => /^\w{3}, \w{3} \d+$/.test(t)),
    );
    expect(
      dayLabels.size,
      `expected one night, saw ${[...dayLabels].join(" / ")}`,
    ).toBeLessThanOrEqual(1);
  });

  test("a scorekeeper sees only the leagues they keep score for", async ({
    page,
  }) => {
    // The control for the test above. `single-league-scorer@` belongs to obhl
    // only, so the Harbor game seeded for tonight must NOT appear — otherwise
    // "cross-league" would just mean "every league", which is a leak rather than
    // a feature.
    await signedInAs(page, "One-league scorer");

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

    await signedInAs(page, "Scorekeeper");
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

  test("the scorekeeper can set a lineup and score tonight's game", async ({
    page,
  }) => {
    await signedInAs(page, "Scorekeeper");
    await page
      .getByRole("link", { name: "Score", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    const lineupForms = page.locator("form").filter({
      has: page.locator('input[name="player_ids"]'),
    });
    for (const form of [lineupForms.first(), lineupForms.last()]) {
      const boxes = form.locator('input[type="checkbox"]');
      for (let i = 0; i < (await boxes.count()); i++)
        await boxes.nth(i).check();
      await form.getByRole("button", { name: "Save lineup" }).click();
      await page.waitForLoadState("networkidle");
    }

    await page.getByRole("button", { name: "Add goals" }).first().click();
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Complete game" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Final").first()).toBeVisible();
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
    await signedInAs(page, "Scorekeeper");
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

    // ⛔ The goalie is NOT among the lineup checkboxes — that is the change.
    const firstBoxes = lineupForms.first().locator('input[type="checkbox"]');
    const beforeCount = await firstBoxes.count();

    // Save the lineup again. Before the paired fix this deleted the goalie's
    // roster row, because the form no longer submits them.
    await lineupForms
      .first()
      .getByRole("button", { name: "Save lineup" })
      .click();
    await page.waitForLoadState("networkidle");

    // The goalie section still shows a goalie of record — the row survived.
    await expect(
      lineupForms.first().locator('input[type="checkbox"]'),
    ).toHaveCount(beforeCount);
    await expect(page.getByText("Empty-net goals").first()).toBeVisible();
  });

  test("a scoresheet gives the scorekeeper the minimal chrome and a way back", async ({
    page,
  }) => {
    await signedInAs(page, "Scorekeeper");
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

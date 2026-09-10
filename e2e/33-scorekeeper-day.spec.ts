/**
 * The scorekeeper's night: `/manage/tonight`, and the day restriction under it.
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
    role === "Manager" || role === "Captain" ? "/" : "/manage/tonight",
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

    // The fixture seeds three. Asserting the count rather than "at least one"
    // is what would catch the day window silently widening to a whole season.
    //
    // ⛔ BY HREF, NOT BY THE "Score" LABEL. `scoreLabel` says "Edit" once a game
    // is final, and these three games are a SHARED, CONSUMABLE fixture — every
    // spec that finalizes one takes a "Score" label out of circulation. Counting
    // scoresheet links instead counts GAMES, which is the actual claim.
    const scoresheetLinks = page.locator('a[href$="/score"]');
    await expect(scoresheetLinks).toHaveCount(4);

    // ⛔ FOUR, ACROSS TWO LEAGUES — this is the page's whole reason to exist.
    // Three Oceanview games and one Harbor game are seeded tonight, and this
    // account keeps score for both. A page that quietly filtered to one league
    // would still show games and still look right; only the count and the second
    // heading catch it.
    await expect(page.getByText("Oceanview Beer Hockey League")).toBeVisible();
    await expect(page.getByText("Harbor Rec Hockey League")).toBeVisible();
  });

  test("a scorekeeper sees only the leagues they keep score for", async ({
    page,
  }) => {
    // The control for the test above. `single-league-scorer@` belongs to obhl
    // only, so the Harbor game seeded for tonight must NOT appear — otherwise
    // "cross-league" would just mean "every league", which is a leak rather than
    // a feature.
    await signedInAs(page, "One-league scorer");

    await expect(page.locator('a[href$="/score"]')).toHaveCount(3);
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
    await expect(page).toHaveURL("/manage/tonight");
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

  test("the staff row offers the scorekeeper one link, back to tonight", async ({
    page,
  }) => {
    // The row is only drawn inside a league, so this is the journey it serves:
    // the way back from a scoresheet to the night. Their way IN is the landing.
    await signedInAs(page, "Scorekeeper");
    await page
      .getByRole("link", { name: "Score", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    const staff = page.getByRole("navigation", { name: "Staff tools" });
    await expect(staff.getByRole("link", { name: "Tonight" })).toBeVisible();
    await expect(staff.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
    await expect(
      staff.getByRole("link", { name: "People & Roles" }),
    ).toHaveCount(0);
  });
});

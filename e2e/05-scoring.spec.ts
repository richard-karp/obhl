/**
 * Paths 10–11: Score a game and game management.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(
  page: Page,
  role: "Manager" | "Scorekeeper" | "Captain",
) {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  // ⚠️ THE LANDING IS ROLE-DEPENDENT NOW. Everyone still lands on the league
  // picker, except a scorekeeper, who lands on `/tonight` — the only
  // surface they are meant to use. Waiting for "/" unconditionally would hang
  // here for the whole scorekeeper half of this file.
  await page.waitForURL(role === "Scorekeeper" ? "/tonight" : "/");
  await page.goto("/obhl/dashboard");
}

// ── Path 10: Score a game ───────────────────────────────────────────────────

test.describe("Path 10 — Score a game end-to-end", () => {
  test("dress players, record a goal, finalize, verify on public schedule", async ({
    page,
  }) => {
    await signedInAs(page, "Scorekeeper");
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
    await signedInAs(page, "Manager");
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
    await signedInAs(page, "Manager");
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
    await signedInAs(page, "Manager");
    await page.goto("/obhl/schedule");

    // The scorekeeper's game list is the public schedule now, with a
    // button per row for whoever may open a scoresheet.
    await page.getByRole("link", { name: "Score", exact: true }).last().click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // ⛔ RESTORED IN `finally`. `.last()` now resolves to one of TONIGHT's games
    // — the only ones a scorekeeper can open — and postponing nulls
    // `scheduled_at` (`0025`). A failure between the two clicks would leave that
    // game undated forever, taking it off `/tonight` and surfacing later
    // as an unrelated count mismatch in `33-scorekeeper-day`. The sibling test
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

  test("AI game recap card visible on finalized game for manager", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    // The scorekeeper's game list is the public schedule now, with a button
    // per row for whoever may open a scoresheet. ⚠️ "Edit" is the label a
    // FINAL game's button carries (`scoreLabel`), so it is only ever in the
    // results view.
    await page.goto("/obhl/schedule?view=results");

    await page.getByRole("link", { name: "Edit", exact: true }).first().click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    await expect(page.getByText("AI Game Recap").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /recap/i })).toBeVisible();
  });
});

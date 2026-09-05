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
  // Sign-in lands on the league picker — there is no league-agnostic dashboard
  // any more. Every caller below expects to be inside a league's manage tools.
  await page.waitForURL("/");
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

    // Complete the game
    await page.getByRole("button", { name: "Complete game" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Final").first()).toBeVisible();

    // Finalized game appears as a link on public schedule
    await page.goto("/obhl/schedule");
    await expect(page.locator('a[href^="/obhl/games/"]').first()).toBeVisible();
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
    await expect(
      page.getByRole("heading", { name: "Cancelled" }),
    ).toBeVisible();
    const listed = page.locator(`a[href="${new URL(scoresheet).pathname}"]`);
    await expect(listed).toHaveCount(1);
    await listed.click();

    await page.getByRole("button", { name: "Restore to scheduled" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Scheduled").first()).toBeVisible();

    // ...and it leaves again once restored.
    await page.goto("/obhl/schedule");
    await expect(page.getByRole("heading", { name: "Cancelled" })).toHaveCount(
      0,
    );
  });

  test("a visitor is not shown cancelled games", async ({ page, browser }) => {
    // ⚠️ CONTROLLED. A first version asserted the heading was absent on a fresh
    // context — and the seed has no cancelled game, so it passed whether or not
    // the gate worked. There has to BE one for the absence to mean anything.
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

    await page.getByRole("button", { name: "Postpone" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Postponed").first()).toBeVisible();

    await page.getByRole("button", { name: "Restore to scheduled" }).click();
    await page.waitForLoadState("networkidle");
  });

  test("AI game recap card visible on finalized game for manager", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await page.goto("/obhl/schedule");

    // The scorekeeper's game list is the public schedule now, with a
    // button per row for whoever may open a scoresheet.
    await page.getByRole("link", { name: "Edit", exact: true }).first().click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    await expect(page.getByText("AI Game Recap").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /recap/i })).toBeVisible();
  });
});

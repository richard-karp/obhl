/**
 * Paths 10–11: Score a game and game management.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

// ── Path 10: Score a game ───────────────────────────────────────────────────

test.describe("Path 10 — Score a game end-to-end", () => {
  test("dress players, record a goal, finalize, verify on public schedule", async ({
    page,
  }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/score");

    // Open first scheduled game
    await page
      .locator("table tbody tr")
      .filter({ has: page.getByRole("link", { name: "Score" }) })
      .first()
      .getByRole("link", { name: "Score" })
      .click();
    await expect(page).toHaveURL(/\/score\//);

    // Dress all players for away team
    const lineupForms = page.locator("form").filter({
      has: page.locator('input[name="player_ids"]'),
    });
    const awayBoxes = lineupForms.first().locator('input[type="checkbox"]');
    for (let i = 0; i < (await awayBoxes.count()); i++) {
      await awayBoxes.nth(i).check();
    }
    await lineupForms.first().getByRole("button", { name: "Save lineup" }).click();
    await page.waitForLoadState("networkidle");

    // Dress all players for home team
    const homeBoxes = lineupForms.last().locator('input[type="checkbox"]');
    for (let i = 0; i < (await homeBoxes.count()); i++) {
      await homeBoxes.nth(i).check();
    }
    await lineupForms.last().getByRole("button", { name: "Save lineup" }).click();
    await page.waitForLoadState("networkidle");

    // Record one goal using the aria-labeled + button
    await page.getByRole("button", { name: "Add goals" }).first().click();
    await page.waitForLoadState("networkidle");

    // Complete the game
    await page.getByRole("button", { name: "Complete game" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Final").first()).toBeVisible();

    // Finalized game appears as a link on public schedule
    await page.goto("/schedule");
    await expect(page.locator('a[href^="/games/"]').first()).toBeVisible();
  });
});

// ── Path 11: Game management ────────────────────────────────────────────────

test.describe("Path 11 — Game management", () => {
  test("cancel a scheduled game and restore it", async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/score");

    await page
      .locator("table tbody tr")
      .filter({ has: page.getByRole("link", { name: "Score" }) })
      .last()
      .getByRole("link")
      .click();
    await expect(page).toHaveURL(/\/score\//);

    await page.getByRole("button", { name: "Cancel game" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Cancelled").first()).toBeVisible();

    await page.getByRole("button", { name: "Restore to scheduled" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Scheduled").first()).toBeVisible();
  });

  test("postpone a game and restore it", async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/score");

    await page
      .locator("table tbody tr")
      .filter({ has: page.getByRole("link", { name: "Score" }) })
      .last()
      .getByRole("link")
      .click();
    await expect(page).toHaveURL(/\/score\//);

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
    await page.goto("/score");

    await page
      .locator("table tbody tr")
      .filter({ has: page.getByRole("link", { name: "Edit" }) })
      .first()
      .getByRole("link", { name: "Edit" })
      .click();
    await expect(page).toHaveURL(/\/score\//);

    await expect(page.getByText("AI Game Recap").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /recap/i })).toBeVisible();
  });
});

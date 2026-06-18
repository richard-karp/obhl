/**
 * Path 15: Role-based access — scorekeepers and captains blocked from manager-only routes.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

test.describe("Path 15 — Role-based access control", () => {
  test("scorekeeper cannot reach /seasons", async ({ page }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/seasons");
    await expect(page).toHaveURL(/login|dashboard/);
  });

  test("scorekeeper cannot reach /audit", async ({ page }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/audit");
    await expect(page).toHaveURL(/login|dashboard/);
  });

  test("scorekeeper cannot reach /people", async ({ page }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/people");
    await expect(page).toHaveURL(/login|dashboard/);
  });

  test("scorekeeper CAN reach /score", async ({ page }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/score");
    await expect(page.getByRole("heading", { name: "Games" })).toBeVisible();
  });

  test("captain sees only their team's lineup form on the scoresheet", async ({
    page,
  }) => {
    await signedInAs(page, "Captain");
    // Captain lands on dashboard which shows upcoming games with "Set lineup" links
    await expect(page).toHaveURL("/dashboard");

    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await expect(gameLink).toBeVisible();
    await gameLink.click();
    await expect(page).toHaveURL(/\/score\//);

    // Captain sees only their own team's lineup form, not the opponent's
    const lineupForms = page.locator("form").filter({
      has: page.locator('input[name="player_ids"]'),
    });
    await expect(lineupForms).toHaveCount(1);
  });

  test("unauthenticated user cannot reach /dashboard", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});

/**
 * Path 15: Role-based access — scorekeepers and captains blocked from manager-only routes.
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

test.describe("Path 15 — Role-based access control", () => {
  test("scorekeeper cannot reach /seasons", async ({ page }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/obhl/seasons");
    await expect(page).toHaveURL("/");
  });

  test("scorekeeper cannot reach /audit", async ({ page }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/obhl/audit");
    await expect(page).toHaveURL("/");
  });

  test("scorekeeper cannot reach /people", async ({ page }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/obhl/people");
    await expect(page).toHaveURL("/");
  });

  test("scorekeeper CAN reach the games they score", async ({ page }) => {
    // `/score` merged into the public schedule. The page is reachable by
    // everyone now, so what says a scorekeeper is entitled is the Score button
    // on it — the affordance, not the URL.
    await signedInAs(page, "Scorekeeper");
    await page.goto("/obhl/schedule");
    await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Score", exact: true }).first(),
    ).toBeVisible();
  });

  test("captain sees only their team's lineup form on the scoresheet", async ({
    page,
  }) => {
    await signedInAs(page, "Captain");
    // Captain lands on dashboard which shows upcoming games with "Set lineup" links
    await expect(page).toHaveURL("/obhl/dashboard");

    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await expect(gameLink).toBeVisible();
    await gameLink.click();
    await expect(page).toHaveURL(/\/games\/[^/]+\/score$/);

    // Captain sees only their own team's lineup form, not the opponent's
    const lineupForms = page.locator("form").filter({
      has: page.locator('input[name="player_ids"]'),
    });
    await expect(lineupForms).toHaveCount(1);
  });

  test("unauthenticated user cannot reach /dashboard", async ({ page }) => {
    await page.goto("/obhl/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});

/**
 * Path 18: Captain lineup — captain can save their team's dressed roster
 * on the scoresheet (extends the access check in 09-access which only verifies
 * the form exists).
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

test.describe("Path 18 — Captain lineup save", () => {
  test("captain can check players and save lineup on their team's game", async ({
    page,
  }) => {
    await signedInAs(page, "Captain");

    // Dashboard shows upcoming games with "Set lineup" links
    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await expect(gameLink).toBeVisible();
    await gameLink.click();
    await expect(page).toHaveURL(/\/score\//);

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

  test("captain cannot save opponent lineup (form count stays at 1)", async ({
    page,
  }) => {
    await signedInAs(page, "Captain");

    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await gameLink.click();
    await expect(page).toHaveURL(/\/score\//);

    const lineupForms = page
      .locator("form")
      .filter({ has: page.locator('input[name="player_ids"]') });
    await expect(lineupForms).toHaveCount(1);
  });
});

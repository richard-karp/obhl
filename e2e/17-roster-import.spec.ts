/**
 * The new-league page offers the rosters-only esportsdesk import, and nothing else.
 *
 * The spec stops at the form, so it never makes an outbound fetch to esportsdesk.
 */
import { test, expect } from "@playwright/test";

test("the new-league page offers a rosters-only import", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/manage/leagues/new");

  await expect(page.getByLabel("esportsdesk league URL")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview" })).toBeVisible();
  await expect(page.getByText(/imports the teams and players only/i)).toBeVisible();
  await expect(page.getByText(/full migration/i)).toHaveCount(0);
});

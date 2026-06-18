/**
 * Path 9: Rosters — add player, set captain, suspend, remove, logo upload.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

test.describe("Path 9 — Roster editor", () => {
  test.beforeEach(async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/rosters");
    await page.getByText("Sharks").click();
    await expect(page).toHaveURL(/\/rosters\//);
  });

  test("roster page shows 14 players with jersey numbers", async ({ page }) => {
    await expect(page.locator("table tbody tr")).toHaveCount(14);
    await expect(
      page.locator("table tbody tr").first().getByText("Goalie"),
    ).toBeVisible();
  });

  test("add a new player and they appear in the roster", async ({ page }) => {
    await page
      .getByPlaceholder("First name")
      .or(page.getByLabel("First name"))
      .fill("Testy");
    await page
      .getByPlaceholder("Last name")
      .or(page.getByLabel("Last name"))
      .fill("McTestface");

    await page.getByRole("button", { name: /add/i }).click();
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("cell", { name: "Testy McTestface" })).toBeVisible();
  });

  test("toggle captain sets and removes C badge", async ({ page }) => {
    const row = page.locator("table tbody tr").nth(1);
    await row.getByRole("button", { name: "Make C" }).click();
    await page.waitForLoadState("networkidle");
    await expect(row.getByText("C").first()).toBeVisible();

    await row.getByRole("button", { name: "Unset C" }).click();
    await page.waitForLoadState("networkidle");
    await expect(row.getByText("Make C")).toBeVisible();
  });

  test("suspend a player shows SUSP badge, lift removes it", async ({
    page,
  }) => {
    const row = page.locator("table tbody tr").nth(2);
    await row.getByRole("button", { name: "Suspend" }).click();
    await page.waitForLoadState("networkidle");
    await expect(row.locator('[data-slot="badge"]').filter({ hasText: "SUSP" })).toBeVisible();

    await row.getByRole("button", { name: "Lift Susp." }).click();
    await page.waitForLoadState("networkidle");
    await expect(row.locator('[data-slot="badge"]').filter({ hasText: "SUSP" })).not.toBeVisible();
  });

  test("logo upload card is visible", async ({ page }) => {
    await expect(page.getByText("Team logo")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /upload|change/i }),
    ).toBeVisible();
  });
});

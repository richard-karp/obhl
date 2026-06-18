/**
 * Path 12: Audit log — view logged actions and session-based revert.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

test.describe("Path 12 — Audit log", () => {
  test("suspension action appears in the audit log", async ({ page }) => {
    await signedInAs(page, "Manager");

    await page.goto("/rosters");
    await page.getByText("Bears").click();
    await expect(page).toHaveURL(/\/rosters\//);

    await page.locator("table tbody tr").nth(2)
      .getByRole("button", { name: "Suspend" })
      .click();
    await page.waitForLoadState("networkidle");

    await page.goto("/audit");
    // Accept any visible mention of the action — the UI shows either a formatted
    // label ("Updated is suspended for [Name]") in session cards or the raw
    // action string ("update_player_status") in a table view.
    await expect(
      page.getByText(/update_player_status|Updated is suspended for/i).first(),
    ).toBeVisible();
  });

  test("captain toggle appears in audit log", async ({ page }) => {
    await signedInAs(page, "Manager");

    await page.goto("/rosters");
    await page.getByText("Bears").click();
    await expect(page).toHaveURL(/\/rosters\//);

    // Toggle captain status on the first skater row (nth(1) skips goalie)
    const row = page.locator("table tbody tr").nth(1);
    const makeC = row.getByRole("button", { name: "Make C" });
    const unsetC = row.getByRole("button", { name: "Unset C" });
    const hasMakeC = await makeC.isVisible().catch(() => false);
    if (hasMakeC) {
      await makeC.click();
    } else {
      await unsetC.click();
    }
    await page.waitForLoadState("networkidle");

    await page.goto("/audit");
    await expect(
      page.getByText(/toggle_captain|Made.*captain|Removed captain/i).first(),
    ).toBeVisible();
  });

  test("revert button is present when session entries exist", async ({ page }) => {
    await signedInAs(page, "Manager");

    // Create a revertible action
    await page.goto("/rosters");
    await page.getByText("Wolves").click();
    await expect(page).toHaveURL(/\/rosters\//);
    await page.locator("table tbody tr").nth(2)
      .getByRole("button", { name: "Suspend" })
      .click();
    await page.waitForLoadState("networkidle");

    await page.goto("/audit");
    const revertBtn = page.getByRole("button", { name: /revert selected/i }).first();
    await expect(revertBtn).toBeVisible();
    await revertBtn.click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/reverted successfully/i)).toBeVisible();
  });
});

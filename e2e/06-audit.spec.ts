/**
 * Path 12: Audit log — view logged actions and session-based revert.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The EDITABLE roster table, scoped to its region. The team page renders the
 * public roster first and the editor below it, so a bare `table tbody tr` picks
 * up the public table — same players, no buttons.
 */
function rosterRows(page: Page) {
  return page
    .getByRole("region", { name: "Manage roster" })
    .locator("table tbody tr");
}

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

test.describe("Path 12 — Audit log", () => {
  test("suspension action appears in the audit log", async ({ page }) => {
    await signedInAs(page, "Manager");

    await page.goto("/obhl/teams");
    await page.getByText("Bears").click();
    await expect(page).toHaveURL(/\/teams\//);
    // The editing forms are simply on the page for a manager now — no tab to
    // open and no `?tab=` to wait for.

    await rosterRows(page)
      .nth(2)
      .getByRole("button", { name: "Suspend" })
      .click();
    await page.waitForLoadState("networkidle");

    await page.goto("/obhl/audit");
    // Accept any visible mention of the action — the UI shows either a formatted
    // label ("Updated is suspended for [Name]") in session cards or the raw
    // action string ("update_player_status") in a table view.
    await expect(
      page.getByText(/update_player_status|Updated is suspended for/i).first(),
    ).toBeVisible();
  });

  test("captain toggle appears in audit log", async ({ page }) => {
    await signedInAs(page, "Manager");

    await page.goto("/obhl/teams");
    await page.getByText("Bears").click();
    await expect(page).toHaveURL(/\/teams\//);
    // The editing forms are simply on the page for a manager now — no tab to
    // open and no `?tab=` to wait for.

    // Toggle captain status on the first skater row (nth(1) skips goalie)
    const row = rosterRows(page).nth(1);
    const makeC = row.getByRole("button", { name: "Make C" });
    const unsetC = row.getByRole("button", { name: "Unset C" });
    const hasMakeC = await makeC.isVisible().catch(() => false);
    if (hasMakeC) {
      await makeC.click();
    } else {
      await unsetC.click();
    }
    await page.waitForLoadState("networkidle");

    await page.goto("/obhl/audit");
    await expect(
      page.getByText(/toggle_captain|Made.*captain|Removed captain/i).first(),
    ).toBeVisible();
  });

  test("revert button is present when session entries exist", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");

    // Create a revertible action
    await page.goto("/obhl/teams");
    await page.getByText("Wolves").click();
    await expect(page).toHaveURL(/\/teams\//);
    // The editing forms are simply on the page for a manager now — no tab to
    // open and no `?tab=` to wait for.
    await rosterRows(page)
      .nth(2)
      .getByRole("button", { name: "Suspend" })
      .click();
    await page.waitForLoadState("networkidle");

    await page.goto("/obhl/audit");
    const revertBtn = page
      .getByRole("button", { name: /revert selected/i })
      .first();
    await expect(revertBtn).toBeVisible();
    await revertBtn.click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/reverted successfully/i)).toBeVisible();
  });
});

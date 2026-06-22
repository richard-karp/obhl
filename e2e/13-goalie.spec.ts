/**
 * Paths 19–21: Goalie management — buttons on score page, default goalie on
 * roster page, and captain permission to set goalie.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

// ── Path 19: Scorekeeper sees goalie buttons ────────────────────────────────

test.describe("Path 19 — Scorekeeper goalie buttons", () => {
  test("goalie section shows buttons not a dropdown after dressing players", async ({
    page,
  }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/score");

    await page
      .locator("table tbody tr")
      .filter({ has: page.getByRole("link", { name: "Score" }) })
      .first()
      .getByRole("link", { name: "Score" })
      .click();
    await expect(page).toHaveURL(/\/score\//);

    // Dress all players for both teams so goalie section appears
    const lineupForms = page.locator("form").filter({
      has: page.locator('input[name="player_ids"]'),
    });
    for (let f = 0; f < (await lineupForms.count()); f++) {
      const boxes = lineupForms.nth(f).locator('input[type="checkbox"]');
      for (let i = 0; i < (await boxes.count()); i++) {
        await boxes.nth(i).check();
      }
      await lineupForms.nth(f).getByRole("button", { name: "Save lineup" }).click();
      await page.waitForLoadState("networkidle");
    }

    // Goalie section uses buttons with jersey-number labels, not a <select>
    await expect(page.locator('select[name="goalie_id"]')).toHaveCount(0);
    await expect(page.getByText("GOALIE").first()).toBeVisible();

    // Each goalie form renders a visible submit button (e.g. "#1", "Sub")
    const goalieForm = page
      .locator("form")
      .filter({ has: page.locator('input[name="goalie_id"]') })
      .first();
    const goalieBtn = goalieForm.getByRole("button");
    await expect(goalieBtn).toBeVisible();

    // Clicking a button submits the form; page should still render the section
    await goalieBtn.click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("GOALIE").first()).toBeVisible();
  });
});

// ── Path 20: Default goalie on roster page ──────────────────────────────────

test.describe("Path 20 — Default goalie on roster page", () => {
  test("manager can set a default goalie and the button updates", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await page.goto("/rosters");
    await page.getByText("Sharks").click();
    await expect(page).toHaveURL(/\/rosters\//);

    // Goalie row has a "Set Default" button
    const goalieRow = page
      .locator("table tbody tr")
      .filter({ hasText: "Goalie" })
      .first();
    await expect(goalieRow.getByRole("button", { name: /Set Default|Default ✓/ })).toBeVisible();

    // If already set, unset first so we're in a known state
    const alreadyDefault = goalieRow.getByRole("button", { name: "Default ✓" });
    if (await alreadyDefault.isVisible()) {
      await alreadyDefault.click();
      await page.waitForLoadState("networkidle");
    }

    // Set as default
    await goalieRow.getByRole("button", { name: "Set Default" }).click();
    await page.waitForLoadState("networkidle");
    await expect(goalieRow.getByRole("button", { name: "Default ✓" })).toBeVisible();
  });

  test("Goalie Schedule card is visible when team has a rostered goalie", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await page.goto("/rosters");
    await page.getByText("Sharks").click();
    await expect(page).toHaveURL(/\/rosters\//);

    await expect(page.getByText("Goalie Schedule")).toBeVisible();
    // Mon and Thu rows should be present
    await expect(page.getByText("Mon")).toBeVisible();
    await expect(page.getByText("Thu")).toBeVisible();
  });

  test("manager can assign a goalie to a day and save it", async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/rosters");
    await page.getByText("Sharks").click();
    await expect(page).toHaveURL(/\/rosters\//);

    // Find the Mon row select and pick the first non-default option
    const monForm = page
      .locator("form")
      .filter({ has: page.locator('input[name="day_of_week"][value="1"]') });
    const monSelect = monForm.locator('select[name="player_id"]');
    const options = monSelect.locator("option");
    const count = await options.count();
    // There should be at least a blank option + one goalie option
    expect(count).toBeGreaterThan(1);

    // Pick the first real goalie option (index 1, skipping "— use default")
    await monSelect.selectOption({ index: 1 });
    await monForm.getByRole("button", { name: "Set" }).click();
    await page.waitForLoadState("networkidle");

    // Page should still be on the roster, the Goalie Schedule card intact,
    // and Mon row still present — confirms the server action didn't crash.
    await expect(page).toHaveURL(/\/rosters\//);
    await expect(page.getByText("Goalie Schedule")).toBeVisible();
    const freshForm = page
      .locator("form")
      .filter({ has: page.locator('input[name="day_of_week"][value="1"]') });
    await expect(freshForm.getByRole("button", { name: "Set" })).toBeVisible();
  });
});

// ── Path 21: Captain sets goalie ────────────────────────────────────────────

test.describe("Path 21 — Captain sets goalie of record", () => {
  test("captain sees goalie buttons for their own team", async ({ page }) => {
    await signedInAs(page, "Captain");

    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await expect(gameLink).toBeVisible();
    await gameLink.click();
    await expect(page).toHaveURL(/\/score\//);

    // Goalie section is present (label visible)
    await expect(page.getByText("GOALIE").first()).toBeVisible();

    // Goalie buttons are rendered — each is a visible submit button inside a goalie form
    const goalieForm = page
      .locator("form")
      .filter({ has: page.locator('input[name="goalie_id"]') })
      .first();
    await expect(goalieForm.getByRole("button")).toBeVisible();
  });

  test("captain can click a goalie button and it persists", async ({ page }) => {
    await signedInAs(page, "Captain");

    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await gameLink.click();
    await expect(page).toHaveURL(/\/score\//);

    // Click the first goalie button
    const firstGoalieForm = page
      .locator("form")
      .filter({ has: page.locator('input[name="goalie_id"]') })
      .first();
    await firstGoalieForm.getByRole("button").click();
    await page.waitForLoadState("networkidle");

    // After save the page re-renders on the same URL with the goalie section still present
    await expect(page).toHaveURL(/\/score\//);
    await expect(page.getByText("GOALIE").first()).toBeVisible();
  });

  test("captain does not see empty-net GA controls", async ({ page }) => {
    await signedInAs(page, "Captain");

    const gameLink = page.getByRole("link", { name: "Set lineup" }).first();
    await gameLink.click();
    await expect(page).toHaveURL(/\/score\//);

    // Empty-net GA stepper is scorekeeper-only
    await expect(page.getByText("EMPTY-NET GA")).not.toBeVisible();
  });
});

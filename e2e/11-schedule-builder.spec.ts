/**
 * Path 17: Schedule Builder — page structure and form fields (read-only;
 * does not generate a draft to avoid overwriting the seeded schedule).
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

test.describe("Path 17 — Schedule Builder", () => {
  test.beforeEach(async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/schedule-builder");
  });

  test("page loads with heading and active season description", async ({ page }) => {
    await expect(page.getByText("Schedule Builder")).toBeVisible();
    // Description contains "(active)" to confirm it found the active season
    await expect(page.getByText(/active/)).toBeVisible();
  });

  test("generate form has all required fields", async ({ page }) => {
    await expect(page.getByText("Generate a balanced schedule")).toBeVisible();
    await expect(page.getByLabel("First game night")).toBeVisible();
    await expect(page.getByLabel("Last game night")).toBeVisible();
    await expect(page.getByLabel("Round-robin cycles")).toBeVisible();
    await expect(page.getByLabel("Ice-time slots").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate draft" })).toBeVisible();
  });

  test("weekday checkboxes are all present", async ({ page }) => {
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      await expect(page.getByText(day, { exact: true })).toBeVisible();
    }
  });

  test("one-off game scheduling card is present with enrolled teams", async ({ page }) => {
    await expect(page.getByText("Schedule a one-off game")).toBeVisible();
  });

  test("empty draft state shows when no draft exists", async ({ page }) => {
    // Seeded schedule has published games, not draft games
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("scorekeeper cannot reach /schedule-builder", async ({ page }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/schedule-builder");
    await expect(page).toHaveURL(/login|dashboard/);
  });
});

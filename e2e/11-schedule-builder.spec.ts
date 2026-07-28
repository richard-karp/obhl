/**
 * Path 17: Schedule Builder — page structure, the balanced generator, and
 * manager-only access.
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
    await expect(page.getByText(/active/)).toBeVisible();
  });

  test("generate form has the length toggle and core fields", async ({ page }) => {
    await expect(page.getByText("Generate a balanced schedule")).toBeVisible();
    await expect(page.getByLabel("First game night")).toBeVisible();
    await expect(page.getByRole("button", { name: "By games per team" })).toBeVisible();
    await expect(page.getByRole("button", { name: "By end date" })).toBeVisible();
    await expect(page.getByLabel("Games per team")).toBeVisible();
    await expect(page.getByLabel(/Ice-time slots/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate schedule" })).toBeVisible();
  });

  test("length toggle swaps games-per-team for an end date", async ({ page }) => {
    await expect(page.getByLabel("Games per team")).toBeVisible();
    await page.getByRole("button", { name: "By end date" }).click();
    await expect(page.getByLabel("Last regular-season night")).toBeVisible();
    await expect(page.getByLabel("Games per team")).toHaveCount(0);
  });

  test("weekday checkboxes are all present", async ({ page }) => {
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      await expect(page.getByText(day, { exact: true })).toBeVisible();
    }
  });

  test("one-off scheduling has moved off the builder, behind a link", async ({
    page,
  }) => {
    // The builder is pre-season only: draft → review → publish. Scheduling a
    // one-off is a mid-season edit to published games and lives on its own page.
    await expect(
      page.getByText("Schedule a one-off game (tournament final / semifinals)"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Schedule a one-off game" }),
    ).toBeVisible();
  });

  test("empty draft state shows before a draft is generated", async ({ page }) => {
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("generates a balanced draft with equal games per team", async ({ page }) => {
    // The active season runs May–Jun 2026; start within it.
    await page.getByLabel("First game night").fill("2026-05-12");
    await page.getByLabel("Games per team").fill("4");
    // Two game nights so weekday balance is exercised.
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();

    await page.getByRole("button", { name: "Generate schedule" }).click();

    // Draft preview appears: balance report and a Publish button.
    await expect(page.getByText("Balance report")).toBeVisible();
    await expect(page.getByRole("button", { name: /Publish \d+ games/ })).toBeVisible();

    // Every team's GP cell should read 4 (equal games per team).
    const gpCells = page.locator("tbody tr td:nth-child(2)");
    const count = await gpCells.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i++) {
      await expect(gpCells.nth(i)).toHaveText("4");
    }

    // Clean up so later runs still see the empty-draft state.
    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("scorekeeper cannot reach /schedule-builder", async ({ page }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/schedule-builder");
    await expect(page).toHaveURL(/login|dashboard/);
  });
});

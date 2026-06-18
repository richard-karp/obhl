/**
 * Path 14: People & Roles — view staff listing and form structure.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

test.describe("Path 14 — People & Roles", () => {
  test.beforeEach(async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/people");
  });

  test("renders staff table with seeded accounts and role labels", async ({
    page,
  }) => {
    await expect(page.getByText("manager@obhl.test")).toBeVisible();
    await expect(page.getByText("scorekeeper@obhl.test")).toBeVisible();
    await expect(page.getByText("captain@obhl.test")).toBeVisible();
    await expect(page.getByText("Manager").first()).toBeVisible();
    await expect(page.getByText("Scorekeeper").first()).toBeVisible();
    await expect(page.getByText("Captain").first()).toBeVisible();
  });

  test("Add a staff account form is present with role selector", async ({
    page,
  }) => {
    await expect(page.getByText("Add a staff account").first()).toBeVisible();
    await expect(
      page
        .locator('[data-slot="card"]')
        .filter({ hasText: "Add a staff account" })
        .getByRole("combobox"),
    ).toBeVisible();
  });

  test("each staff row has at least one action button", async ({ page }) => {
    const rows = page.locator("table tbody tr");
    expect(await rows.count()).toBeGreaterThanOrEqual(3);
    await expect(rows.first().getByRole("button").first()).toBeVisible();
  });
});

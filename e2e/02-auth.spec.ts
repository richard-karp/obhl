/**
 * Path 6: Auth — login and session management.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("/login");
}

test.describe("Path 6 — Auth / Login / Session", () => {
  test("dev quick sign-in as manager redirects to dashboard with correct role", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await expect(page.getByRole("heading", { name: "Manage" })).toBeVisible();
    await expect(page.getByText("People & Roles").first()).toBeVisible();
    await expect(page.getByText("Seasons").first()).toBeVisible();
  });

  test("sign out returns to /login", async ({ page }) => {
    await signedInAs(page, "Manager");
    await signOut(page);
    await expect(page).toHaveURL("/login");
    await expect(
      page.getByRole("heading", { name: "Staff sign in" }),
    ).toBeVisible();
  });

  test("unauthenticated access to /seasons redirects to /login", async ({
    page,
  }) => {
    await page.goto("/seasons");
    await expect(page).toHaveURL(/\/login/);
  });

  test("scorekeeper dashboard shows Score Games card but not People & Roles", async ({ page }) => {
    await signedInAs(page, "Scorekeeper");
    await expect(page.getByText("Score Games").first()).toBeVisible();
    // People & Roles card should not appear on a scorekeeper dashboard
    const peopleCard = page.locator('[data-slot="card-title"]', { hasText: "People & Roles" });
    await expect(peopleCard).not.toBeVisible();
  });

  test("captain dashboard shows team card", async ({ page }) => {
    await signedInAs(page, "Captain");
    await expect(page.getByText(/captain the/i)).toBeVisible();
  });
});

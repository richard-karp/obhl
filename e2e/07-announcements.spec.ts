/**
 * Path 13: Announcements — post, verify on homepage, delete.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

const TEST_TITLE = `E2E Test Announcement ${Date.now()}`;
const TEST_BODY = "This was posted by an automated test and should be deleted.";

test.describe("Path 13 — Announcements", () => {
  test("post an announcement, verify on homepage, then delete it", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await page.goto("/announcements");

    await page
      .getByLabel("Title")
      .or(page.getByPlaceholder("Title"))
      .fill(TEST_TITLE);
    await page
      .getByLabel("Message")
      .or(page.getByPlaceholder("Write the announcement…"))
      .fill(TEST_BODY);

    await page.getByRole("button", { name: "Post announcement" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(TEST_TITLE)).toBeVisible();

    // Visible on public homepage
    await page.goto("/");
    await expect(page.getByText(TEST_TITLE)).toBeVisible();

    // Delete from manage page
    await page.goto("/announcements");
    await page
      .locator('[data-slot="card"]')
      .filter({ hasText: TEST_TITLE })
      .getByRole("button", { name: "Delete" })
      .click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(TEST_TITLE)).not.toBeVisible();

    // Gone from homepage
    await page.goto("/");
    await expect(page.getByText(TEST_TITLE)).not.toBeVisible();
  });
});

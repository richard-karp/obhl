/**
 * Path 16: League Rules — manager edits rules, public page renders them.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

const RULES_TEXT = `E2E test rule: no high-sticking at ${Date.now()}`;

test.describe("Path 16 — League Rules", () => {
  test("rules editor page loads with toolbar and save button", async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/rules/edit");

    await expect(page.locator("h1").filter({ hasText: "League Rules" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save rules" })).toBeVisible();

    // Formatting toolbar buttons (exact: true — single letters otherwise substring-match unrelated buttons)
    await expect(page.getByRole("button", { name: "B", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "I", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "H2", exact: true })).toBeVisible();
  });

  test("manager saves rules and they appear on the public rules page", async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/rules/edit");

    // Type into the Tiptap contenteditable editor
    const editor = page.locator('[contenteditable="true"]');
    await editor.click();
    await editor.fill(RULES_TEXT);

    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10000 });

    // Verify content appears on the public rules page
    await page.goto("/rules");
    await expect(page.getByText(RULES_TEXT)).toBeVisible();
  });

  test("public rules page is accessible without login", async ({ page }) => {
    await page.goto("/rules");
    // Either shows rules content or the empty state — never an auth redirect
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator("h1").filter({ hasText: "League Rules" })).toBeVisible();
  });
});

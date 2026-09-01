/**
 * Path 16: League Rules — manager edits rules, public page renders them.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  // Sign-in lands on the league picker — there is no league-agnostic dashboard
  // any more. Every caller below expects to be inside a league's manage tools.
  await page.waitForURL("/");
  await page.goto("/obhl/manage/dashboard");
}

const RULES_TEXT = `E2E test rule: no high-sticking at ${Date.now()}`;

test.describe("Path 16 — League Rules", () => {
  test("rules editor page loads with toolbar and save button", async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/obhl/manage/rules/edit");

    await expect(page.locator("h1").filter({ hasText: "League Rules" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save rules" })).toBeVisible();

    // Formatting toolbar buttons (exact: true — single letters otherwise substring-match unrelated buttons)
    await expect(page.getByRole("button", { name: "B", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "I", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "H2", exact: true })).toBeVisible();
  });

  test("manager saves rules and they appear on the public rules page", async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/obhl/manage/rules/edit");

    // Type into the Tiptap contenteditable editor
    const editor = page.locator('[contenteditable="true"]');
    await editor.click();
    await editor.fill(RULES_TEXT);

    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10000 });

    // Verify content appears on the public rules page
    await page.goto("/obhl/rules");
    await expect(page.getByText(RULES_TEXT)).toBeVisible();
  });

  // Guards the trap in src/lib/audit.ts: an entity_type that leagueOfEntity
  // does not handle logs with a null league, and the audit page filters on
  // `league_id`. The entry would be written correctly and never be seen, so
  // asserting it was written is not enough — it has to appear in the
  // league-scoped view a manager actually reads.
  test("saving rules appears in this league's audit log", async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/obhl/manage/rules/edit");

    const editor = page.locator('[contenteditable="true"]');
    await editor.click();
    await editor.fill(`Audited rule change at ${Date.now()}`);
    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10000 });

    await page.goto("/obhl/manage/audit");
    await expect(page.getByText("Updated league rules").first()).toBeVisible();
  });

  test("public rules page is accessible without login", async ({ page }) => {
    await page.goto("/obhl/rules");
    // Either shows rules content or the empty state — never an auth redirect
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator("h1").filter({ hasText: "League Rules" })).toBeVisible();
  });
});

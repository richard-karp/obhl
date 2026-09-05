/**
 * Path 16: League Rules — one page, two hats.
 *
 * `/rules` and `/manage/rules/edit` were two URLs over one thing. The public
 * page now carries the editor for whoever is entitled to it, so every test here
 * drives `/obhl/rules` and the manager's tests open the editor from it.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

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

/** The shared page, then the editor a manager is offered on it. */
async function openEditor(page: Page) {
  await page.goto("/obhl/rules");
  await page.getByRole("button", { name: "Edit rules" }).click();
}

const RULES_TEXT = `E2E test rule: no high-sticking at ${Date.now()}`;

test.describe("Path 16 — League Rules", () => {
  test("a manager opens the editor from the public page itself", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await openEditor(page);

    await expect(
      page.locator("h1").filter({ hasText: "League Rules" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save rules" }),
    ).toBeVisible();

    // Formatting toolbar buttons (exact: true — single letters otherwise substring-match unrelated buttons)
    await expect(
      page.getByRole("button", { name: "B", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "I", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "H2", exact: true }),
    ).toBeVisible();
  });

  test("manager saves rules and they appear on the public rules page", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await openEditor(page);

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
    await openEditor(page);

    const editor = page.locator('[contenteditable="true"]');
    await editor.click();
    await editor.fill(`Audited rule change at ${Date.now()}`);
    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10000 });

    await page.goto("/obhl/audit");
    await expect(page.getByText("Updated league rules").first()).toBeVisible();

    // Saving again without editing must not add a second entry: these entries
    // carry two whole documents, and re-saving an untouched page changed
    // nothing. Only the current session's card is expanded, so a count here is
    // a count of this test's own entries.
    await openEditor(page);
    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10000 });

    await page.goto("/obhl/audit");
    await expect(page.getByText("Updated league rules")).toHaveCount(1);
  });

  test("public rules page is accessible without login", async ({ page }) => {
    await page.goto("/obhl/rules");
    // Either shows rules content or the empty state — never an auth redirect
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.locator("h1").filter({ hasText: "League Rules" }),
    ).toBeVisible();
  });

  test("an anonymous visitor is offered no way to edit", async ({ page }) => {
    // The merge's whole risk in one assertion: the page that gained an editor
    // must not have gained it for everybody.
    await page.goto("/obhl/rules");
    await expect(page.getByRole("button", { name: "Edit rules" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Save rules" })).toHaveCount(
      0,
    );
  });

  test("the editor closes back to the page a visitor sees", async ({
    page,
  }) => {
    // One renderer for both hats: what the manager reads when not editing is
    // the public page itself, not a second rendering of the same document.
    await signedInAs(page, "Manager");
    await openEditor(page);
    await expect(
      page.getByRole("button", { name: "Save rules" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: "Save rules" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "Edit rules" }),
    ).toBeVisible();
  });

  test("the old /rules/edit URL still lands on the merged page", async ({
    request,
  }) => {
    const res = await request.get("/obhl/rules/edit", { maxRedirects: 0 });
    expect(res.status()).toBe(308);
    expect(
      new URL(res.headers()["location"], "http://localhost").pathname,
    ).toBe("/obhl/rules");
  });
});

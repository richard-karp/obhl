/**
 * Paths 7–8: Season setup and AI league summary.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

async function goToActiveSeasonSetup(page: Page) {
  await page.goto("/seasons");
  await page
    .getByRole("row", { name: /Spring 2026/ })
    .getByRole("link", { name: "Setup" })
    .click();
  await expect(page).toHaveURL(/\/seasons\//);
}

test.describe("Path 7 — Season setup", () => {
  test("seasons list shows Spring 2026 with Active badge", async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/seasons");
    await expect(page.getByText("Spring 2026")).toBeVisible();
    await expect(page.getByText("Active").first()).toBeVisible();
  });

  test("season setup page shows step chips and 6 enrolled teams", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await goToActiveSeasonSetup(page);
    await expect(page.getByText("Season created")).toBeVisible();
    await expect(page.getByText("6 enrolled")).toBeVisible();
    await expect(page.locator("table tbody tr")).toHaveCount(6);
  });

  test("carry-forward button is present on season setup", async ({ page }) => {
    await signedInAs(page, "Manager");
    await goToActiveSeasonSetup(page);
    await expect(
      page.getByRole("button", { name: "Same teams as last season" }),
    ).toBeVisible();
  });
});

test.describe("Path 8 — AI league summary", () => {
  test("League Summary card shows Generate button when no summary exists", async ({
    page,
  }) => {
    await signedInAs(page, "Manager");
    await goToActiveSeasonSetup(page);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("No summary yet")).toBeVisible();
  });

  test("Generate triggers Claude and summary appears on both pages", async ({
    page,
  }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      test.skip(true, "ANTHROPIC_API_KEY not set — skipping live AI call");
      return;
    }

    await signedInAs(page, "Manager");
    await goToActiveSeasonSetup(page);

    await page.getByRole("button", { name: "Generate" }).click();
    await expect(
      page.getByRole("button", { name: "Regenerate" }),
    ).toBeVisible({ timeout: 30_000 });

    const summaryText = await page.locator("p.italic").first().innerText();
    expect(summaryText.length).toBeGreaterThan(20);

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "League Update" }),
    ).toBeVisible();
  });
});

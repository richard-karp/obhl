/** Mid-season transfer. */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signInAsManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
}

async function openRoster(page: Page, team: string) {
  await page.goto("/obhl/teams");
  await page.getByText(team).click();
  await expect(page).toHaveURL(/\/teams\//);
  // The roster editor is a tab on the team page now, not a page of
  // its own behind a uuid.
  await page.getByRole("tab", { name: "Manage" }).click();
}

/**
 * The second cell, not the first. The table is #, Player, Position, Status,
 * Manage — reading `td` first would compare a jersey number against every other
 * number on the page.
 */
async function firstRowName(page: Page) {
  const row = page.locator("table tbody tr").first();
  return (await row.locator("td").nth(1).innerText()).split("\n")[0].trim();
}

test("a clashing jersey number is refused, and nothing moves", async ({
  page,
}) => {
  await signInAsManager(page);

  // Read the number off the destination rather than assuming one. Earlier specs
  // in this suite add and remove players, so a hard-coded number is a test that
  // passes alone and fails in the run — which is how this one first failed.
  await openRoster(page, "Bears");
  const taken = (
    await page
      .locator("table tbody tr")
      .first()
      .locator("td")
      .first()
      .innerText()
  ).trim();
  expect(taken).toMatch(/^\d+$/);

  await openRoster(page, "Sharks");
  const name = await firstRowName(page);
  const row = page.locator("table tbody tr").first();

  await row.getByRole("button", { name: /^transfer$/i }).click();
  await page.getByLabel(/to team/i).selectOption({ label: "Bears" });
  await page.getByLabel(/jersey number/i).fill(taken);
  await page.getByRole("button", { name: /confirm transfer/i }).click();

  // Named, not generic: the operator has to know which number and whose.
  await expect(page.getByRole("status")).toContainText(/already worn by/i);
  // And the refusal happened before any write — they are still here.
  await expect(page.getByRole("cell", { name })).toBeVisible();
});

test("a transferred player leaves one roster and joins the other", async ({
  page,
}) => {
  await signInAsManager(page);
  await openRoster(page, "Sharks");
  const name = await firstRowName(page);
  const row = page.locator("table tbody tr").first();

  await row.getByRole("button", { name: /^transfer$/i }).click();
  await page.getByLabel(/to team/i).selectOption({ label: "Bears" });
  // Cleared, which means "no number on the new team" — the one deterministic
  // choice here, since any number might be taken by the time this runs.
  await page.getByLabel(/jersey number/i).fill("");
  await page.getByRole("button", { name: /confirm transfer/i }).click();
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("cell", { name })).toHaveCount(0);

  await openRoster(page, "Bears");
  await expect(page.getByRole("cell", { name })).toBeVisible();
});

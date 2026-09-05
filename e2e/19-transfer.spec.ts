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
  // The editing forms are simply on the page for a manager now — no tab to open
  // and no `?tab=` to wait for.
  await expect(rosterRows(page).first()).toBeVisible();
}

/**
 * The EDITABLE roster table, scoped to its region. The team page renders the
 * public roster first and the editor below it, so a bare `table tbody tr` picks
 * up the public table — same players, no buttons, and a failure that reads as if
 * the controls had vanished.
 */
function manageRoster(page: Page) {
  return page.getByRole("region", { name: "Manage roster" });
}

function rosterRows(page: Page) {
  return manageRoster(page).locator("table tbody tr");
}

/**
 * The second cell, not the first. The table is #, Player, Position, Status,
 * Manage — reading `td` first would compare a jersey number against every other
 * number on the page.
 */
async function firstRowName(page: Page) {
  const row = rosterRows(page).first();
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
    await rosterRows(page).first().locator("td").first().innerText()
  ).trim();
  expect(taken).toMatch(/^\d+$/);

  await openRoster(page, "Sharks");
  const name = await firstRowName(page);
  const row = rosterRows(page).first();

  await row.getByRole("button", { name: /^transfer$/i }).click();
  await page.getByLabel(/to team/i).selectOption({ label: "Bears" });
  await page.getByLabel(/jersey number/i).fill(taken);
  await page.getByRole("button", { name: /confirm transfer/i }).click();

  // Named, not generic: the operator has to know which number and whose.
  await expect(page.getByRole("status")).toContainText(/already worn by/i);
  // And the refusal happened before any write — they are still here.
  await expect(manageRoster(page).getByRole("cell", { name })).toBeVisible();
});

test("a transferred player leaves one roster and joins the other", async ({
  page,
}) => {
  await signInAsManager(page);
  await openRoster(page, "Sharks");
  const name = await firstRowName(page);
  const row = rosterRows(page).first();

  await row.getByRole("button", { name: /^transfer$/i }).click();
  await page.getByLabel(/to team/i).selectOption({ label: "Bears" });
  // Cleared, which means "no number on the new team" — the one deterministic
  // choice here, since any number might be taken by the time this runs.
  await page.getByLabel(/jersey number/i).fill("");
  await page.getByRole("button", { name: /confirm transfer/i }).click();
  await page.waitForLoadState("networkidle");

  // ⚠️ Scoped to the EDITOR, and it has to be. The public table above it lists
  // anyone with stats for this team whether or not they are still on the roster
  // — which is the whole point of 0036's soft departures — so the transferred
  // player is legitimately still named up there. The claim being tested is that
  // they left the ROSTER, and only the editor's table answers that.
  await expect(manageRoster(page).getByRole("cell", { name })).toHaveCount(0);

  await openRoster(page, "Bears");
  await expect(manageRoster(page).getByRole("cell", { name })).toBeVisible();
});

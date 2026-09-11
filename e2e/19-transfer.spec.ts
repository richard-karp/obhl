/** Mid-season transfer. */
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

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
 * The second cell, not the first: the first is the jersey number.
 *
 * ⛔ BADGES STRIPPED, NOT `.split("\n")[0]`. Captain, rookie, suspended and
 * injury render as inline badges inside this cell with no newline before them,
 * so the old form returned "Taylor GauthierC" for any row that had one.
 */
/**
 * The row these tests move, and it must not be the captain's.
 *
 * ⛔ NOT `rosterRows(page).first()`. The editor is three sections now and
 * Forwards come first, so the first row on Sharks is jersey #6 — who is the
 * seeded CAPTAIN, and the account `13-goalie`'s Path 21 signs in as.
 * Transferring them clears `is_captain` (`movePlayerToTeam` does it
 * deliberately), so this spec silently broke that one whenever it ran first.
 * It passed alone and failed in the suite, which is the worst shape for it.
 * Defence carries no captain in the seed.
 */
function subjectRow(page: Page) {
  return manageRoster(page)
    .getByRole("region", { name: "Manage Defence" })
    .locator("tbody tr")
    .first();
}

async function subjectName(page: Page) {
  const cell = subjectRow(page).locator("td").nth(1);
  const badges = await cell.locator('[data-slot="badge"]').allInnerTexts();
  let name = (await cell.innerText()).trim();
  for (const b of badges) name = name.replace(b, "").trim();
  return name;
}

/**
 * Open a row's editor and return the dialog.
 *
 * ⛔ THE DIALOG IS A PORTAL — NOT INSIDE THE `<tr>`, and while it is open Radix
 * marks the rest of the document `aria-hidden`. So the transfer controls are
 * reached through this, and anything BEHIND it must not be asserted until it
 * is shut, or the assertion passes for the wrong reason.
 */
async function openDialogFor(page: Page, row: Locator) {
  await row.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
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
  const name = await subjectName(page);
  const row = subjectRow(page);

  const dialog = await openDialogFor(page, row);
  await dialog.getByLabel(/to team/i).selectOption({ label: "Bears" });
  await dialog.getByLabel(/jersey number/i).fill(taken);
  await dialog.getByRole("button", { name: /confirm transfer/i }).click();

  // Named, not generic: the operator has to know which number and whose.
  await expect(dialog.getByRole("status")).toContainText(/already worn by/i);
  // And the refusal happened before any write — they are still here. Asserted
  // only after the modal is shut; behind it the roster is `aria-hidden`.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(manageRoster(page).getByRole("cell", { name })).toBeVisible();
});

test("a transferred player leaves one roster and joins the other", async ({
  page,
}) => {
  await signInAsManager(page);
  await openRoster(page, "Sharks");
  const name = await subjectName(page);
  const row = subjectRow(page);

  const dialog = await openDialogFor(page, row);
  await dialog.getByLabel(/to team/i).selectOption({ label: "Bears" });
  // Cleared, which means "no number on the new team" — the one deterministic
  // choice here, since any number might be taken by the time this runs.
  await dialog.getByLabel(/jersey number/i).fill("");
  await dialog.getByRole("button", { name: /confirm transfer/i }).click();
  await page.waitForLoadState("networkidle");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // ⚠️ Scoped to the EDITOR, and it has to be. The public table above it lists
  // anyone with stats for this team whether or not they are still on the roster
  // — which is the whole point of 0036's soft departures — so the transferred
  // player is legitimately still named up there. The claim being tested is that
  // they left the ROSTER, and only the editor's table answers that.
  await expect(manageRoster(page).getByRole("cell", { name })).toHaveCount(0);

  await openRoster(page, "Bears");
  await expect(manageRoster(page).getByRole("cell", { name })).toBeVisible();
});

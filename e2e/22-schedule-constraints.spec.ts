/**
 * Path 22: Manager schedule constraints — telling the generator what to do,
 * and being told what it could not do.
 *
 * Driven through Fall 2026's setup page for the same reason `11-schedule-builder`
 * is: the generate flow only exists on a season that has not started, and the
 * active season is in the past. Both pages render the same
 * `ScheduleBuilderPanel`, so the card under test is identical either way.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAsManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/manage/dashboard");
}

async function goToFallSeasonSetup(page: Page) {
  await page.goto("/obhl/manage/seasons");
  await page
    .getByRole("row", { name: /Fall 2026/ })
    .getByRole("link", { name: "Setup" })
    .click();
  await page.waitForURL(/\/seasons\//);
}

/** See `11-schedule-builder.spec.ts` — Phase S runs five candidates. */
const AFTER_GENERATE = { timeout: 45_000 };

/** The first game night of the window these tests generate over. */
const FIRST_NIGHT = "2026-09-15";

/** Pick the first real team in the constraints card's picker, and return its name. */
async function firstTeamName(page: Page): Promise<string> {
  const select = page.getByLabel("Team", { exact: true });
  const value = await select.locator("option").nth(1).getAttribute("value");
  const name = (await select.locator("option").nth(1).textContent())!.trim();
  await select.selectOption(value!);
  return name;
}

/** Remove every request currently listed, so the suite can re-run from clean. */
async function clearRequests(page: Page) {
  for (;;) {
    const remove = page.getByRole("button", { name: /^Remove request:/ }).first();
    if ((await remove.count()) === 0) break;
    await remove.click();
    await expect(page.getByText(/^Removed that request\./)).toBeVisible();
  }
}

test.describe("Path 22 — schedule constraints", () => {
  // A generate can be ~25 s of search, and two of these run one.
  test.describe.configure({ timeout: 150_000 });

  test.beforeEach(async ({ page }) => {
    await signedInAsManager(page);
    await goToFallSeasonSetup(page);
  });

  test.afterEach(async ({ page }) => {
    await clearRequests(page);
  });

  test("the constraints card sits inside the generate form", async ({ page }) => {
    // ⚠️ Inside the form, not beside it: the season's game nights do not exist
    // until the form above is filled in, so a card rendered elsewhere would have
    // no calendar to talk about.
    const form = page.locator("form").filter({ hasText: "Manager requests" });
    await expect(form.getByRole("button", { name: "Generate schedule" })).toBeVisible();
    await expect(form.getByLabel("Request")).toBeVisible();
    await expect(form.getByRole("button", { name: "Add request" })).toBeVisible();
  });

  test("the request picker offers all six kinds", async ({ page }) => {
    const kinds = page.getByLabel("Request");
    for (const label of [
      "Bye on a night",
      "Bye the whole week",
      "Bye once in a week",
      "Play on a night",
      "Play at an ice time",
      "Prefer early/late ice",
    ]) {
      await expect(kinds.locator("option", { hasText: label })).toHaveCount(1);
    }
  });

  test("adding a request lists it, and removing it takes it away", async ({ page }) => {
    const name = await firstTeamName(page);
    await page.getByLabel("Request").selectOption("bye_on");
    await page.getByLabel("Date", { exact: true }).fill(FIRST_NIGHT);
    await page.getByRole("button", { name: "Add request" }).click();

    await expect(page.getByText(`${name} byes on ${FIRST_NIGHT}`)).toBeVisible();

    await page.getByRole("button", { name: /^Remove request:/ }).first().click();
    await expect(page.getByText(`${name} byes on ${FIRST_NIGHT}`)).toHaveCount(0);
  });

  test("a request with nothing filled in is refused, not silently dropped", async ({
    page,
  }) => {
    await firstTeamName(page);
    await page.getByLabel("Request").selectOption("slot_on");
    await page.getByLabel("Date", { exact: true }).fill(FIRST_NIGHT);
    // No ice time.
    await page.getByRole("button", { name: "Add request" }).click();
    await expect(page.getByText("Enter the ice time as HH:MM.")).toBeVisible();
  });

  test("two requests that contradict each other are refused by name", async ({
    page,
  }) => {
    // The likeliest thing a manager actually does wrong, and the reason
    // contradictions are checked before the arithmetic: the message names both
    // offending requests rather than saying "infeasible".
    const name = await firstTeamName(page);
    await page.getByLabel("Request").selectOption("bye_on");
    await page.getByLabel("Date", { exact: true }).fill(FIRST_NIGHT);
    await page.getByRole("button", { name: "Add request" }).click();
    await expect(page.getByText(`${name} byes on ${FIRST_NIGHT}`)).toBeVisible();

    await firstTeamName(page);
    await page.getByLabel("Request").selectOption("play_on");
    await page.getByLabel("Date", { exact: true }).fill(FIRST_NIGHT);
    await page.getByRole("button", { name: "Add request" }).click();
    await expect(page.getByText(`${name} plays on ${FIRST_NIGHT}`)).toBeVisible();

    await page.getByLabel("First game night").fill(FIRST_NIGHT);
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();

    // Refused on arithmetic in milliseconds, not by a search running its budget
    // out — and the message names both requests.
    await expect(page.getByText(/contradict each other/)).toBeVisible();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("a honoured request shows as met on the preview", async ({ page }) => {
    const name = await firstTeamName(page);
    await page.getByLabel("Request").selectOption("bye_on");
    // The second Tuesday of the window — a night the schedule has room to move
    // a bye onto without the request being the only thing it could do.
    await page.getByLabel("Date", { exact: true }).fill("2026-09-22");
    await page.getByRole("button", { name: "Add request" }).click();
    await expect(page.getByText(`${name} byes on 2026-09-22`)).toBeVisible();

    await page.getByLabel("First game night").fill(FIRST_NIGHT);
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();

    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);

    // The card is derived from the placed draft, not from what the generator
    // was asked to do — so it is still right after a reload.
    const requests = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Manager requests" });
    await expect(requests).toBeVisible();
    await expect(requests.getByText(`${name} byes on 2026-09-22`)).toBeVisible();
    await page.reload();
    await expect(
      page
        .locator('[data-slot="card"]')
        .filter({ hasText: "Manager requests" })
        .getByText(`${name} byes on 2026-09-22`),
    ).toBeVisible();

    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("the requests card is absent when nothing has been asked for", async ({
    page,
  }) => {
    await page.getByLabel("First game night").fill(FIRST_NIGHT);
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();

    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);
    await expect(
      page.locator('[data-slot="card"]').filter({ hasText: "Manager requests" }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });
});

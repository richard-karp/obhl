/**
 * Path 24: Manager schedule constraints — telling the generator what to do,
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

/**
 * The listed requests, and ONLY those.
 *
 * ⛔ Never assert a request's description against the whole page. The card
 * lists it AND sonner toasts it ("Added: <description>."), so a bare
 * `getByText(description)` is a strict-mode violation the moment an add
 * succeeds — the assertion fails precisely when the thing it checks worked.
 */
function requestList(page: Page) {
  return page
    .locator("li")
    .filter({ has: page.getByRole("button", { name: /^Remove request:/ }) });
}

/**
 * The preview's "Manager requests" card — the one that reports whether each
 * request landed.
 *
 * ⛔ NOT `[data-slot="card"]` filtered on the text "Manager requests". The
 * constraints card inside the generate form is headed "Manager requests
 * (optional)", and it lives inside a Card of its own, so that filter always
 * matches TWO elements: the outcome card can never be asserted absent, and
 * asserting it present is a strict-mode violation. Match the card TITLE
 * exactly, which only the outcome card has.
 */
function outcomeCard(page: Page) {
  // `:scope >` pins the card whose OWN header carries the title. Without it the
  // filter also matches every enclosing Card — the builder panel nests them —
  // and a 2-element match makes `toBeVisible` a strict-mode violation.
  return page.locator('[data-slot="card"]').filter({
    has: page.locator(':scope > [data-slot="card-header"]', {
      hasText: /^Manager requests$/,
    }),
  });
}

/**
 * Remove every request currently listed, so the suite can re-run from clean.
 *
 * ⛔ THE LIST SHRINKING IS THE SIGNAL, NOT THE TOAST. Waiting on
 * "Removed that request." looks right and is a trap: sonner stacks and lingers,
 * so on the second pass the toast from the FIRST removal is still on screen and
 * the assertion returns instantly. The loop then clicks the next ✕ while the
 * previous transition still has every remove button disabled and the re-render
 * is detaching them — "element is not enabled", "element was detached", and a
 * 150 s timeout inside afterEach that reads as if the page had hung.
 */
async function clearRequests(page: Page) {
  for (;;) {
    const rows = requestList(page);
    const before = await rows.count();
    if (before === 0) break;
    await rows
      .first()
      .getByRole("button", { name: /^Remove request:/ })
      .click();
    await expect(rows).toHaveCount(before - 1);
  }
}

test.describe("Path 24 — schedule constraints", () => {
  // A generate can be ~25 s of search, and two of these run one.
  test.describe.configure({ timeout: 150_000 });

  test.beforeEach(async ({ page }) => {
    await signedInAsManager(page);
    await goToFallSeasonSetup(page);
  });

  test.afterEach(async ({ page }) => {
    await clearRequests(page);
  });

  test("the constraints card sits inside the generate form", async ({
    page,
  }) => {
    // ⚠️ Inside the form, not beside it: the season's game nights do not exist
    // until the form above is filled in, so a card rendered elsewhere would have
    // no calendar to talk about.
    const form = page.locator("form").filter({ hasText: "Manager requests" });
    await expect(
      form.getByRole("button", { name: "Generate schedule" }),
    ).toBeVisible();
    await expect(form.getByLabel("Request", { exact: true })).toBeVisible();
    await expect(
      form.getByRole("button", { name: "Add request" }),
    ).toBeVisible();
  });

  test("the request picker offers all six kinds", async ({ page }) => {
    const kinds = page.getByLabel("Request", { exact: true });
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

  test("adding a request lists it, and removing it takes it away", async ({
    page,
  }) => {
    const name = await firstTeamName(page);
    await page.getByLabel("Request", { exact: true }).selectOption("bye_on");
    await page.getByLabel("Date", { exact: true }).fill(FIRST_NIGHT);
    await page.getByRole("button", { name: "Add request" }).click();

    await expect(
      requestList(page).filter({ hasText: `${name} byes on ${FIRST_NIGHT}` }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: /^Remove request:/ })
      .first()
      .click();
    await expect(
      requestList(page).filter({ hasText: `${name} byes on ${FIRST_NIGHT}` }),
    ).toHaveCount(0);
  });

  test("a request with nothing filled in is refused, not silently dropped", async ({
    page,
  }) => {
    await firstTeamName(page);
    await page.getByLabel("Request", { exact: true }).selectOption("slot_on");
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
    await page.getByLabel("Request", { exact: true }).selectOption("bye_on");
    await page.getByLabel("Date", { exact: true }).fill(FIRST_NIGHT);
    await page.getByRole("button", { name: "Add request" }).click();
    await expect(
      requestList(page).filter({ hasText: `${name} byes on ${FIRST_NIGHT}` }),
    ).toBeVisible();

    await firstTeamName(page);
    await page.getByLabel("Request", { exact: true }).selectOption("play_on");
    await page.getByLabel("Date", { exact: true }).fill(FIRST_NIGHT);
    await page.getByRole("button", { name: "Add request" }).click();
    await expect(
      requestList(page).filter({ hasText: `${name} plays on ${FIRST_NIGHT}` }),
    ).toBeVisible();

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

  /**
   * ⛔ `slot_on`, NOT `bye_on`, AND THE SEEDED LEAGUE IS WHY.
   *
   * Six teams over the default three sheets is three games a night, so all six
   * play every night and the season has NO BYE BUDGET AT ALL — every bye
   * request is correctly refused by `refuteConstraints` on arithmetic, and no
   * assertion here can make one land. Dropping to two sheets creates byes but
   * walks into the other wall: `planByParticipation` returns null at six teams
   * on two sheets even with nothing constrained, so the fallback planner ships
   * and every request is reported unmet. Both limits are measured on the
   * rank-off note in `assignNights.ts`.
   *
   * `play_on`, `slot_on` and `slot_bias` all work on this shape. `slot_on` is
   * the one worth driving: it is the kind that has to survive BOTH phases —
   * Phase P forcing the play night, Phase S pinning the ice time — and it is
   * read back off the placed games rather than off what either was asked to do.
   */
  test("a honoured request shows as met on the preview", async ({ page }) => {
    const name = await firstTeamName(page);
    await page.getByLabel("Request", { exact: true }).selectOption("slot_on");
    await page.getByLabel("Date", { exact: true }).fill("2026-09-22");
    await page.getByLabel("Ice time").fill("21:30");
    await page.getByRole("button", { name: "Add request" }).click();
    const description = `${name} plays at 21:30 on 2026-09-22`;
    await expect(
      requestList(page).filter({ hasText: description }),
    ).toBeVisible();

    await page.getByLabel("First game night").fill(FIRST_NIGHT);
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();

    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);

    // ⛔ ASSERT THE TICK, not merely that the request is listed. Listing it
    // proves nothing — an unmet request is listed too, with a ✗ — and this test
    // spent its whole life passing over one.
    const row = outcomeCard(page)
      .locator("li")
      .filter({ hasText: description });
    await expect(row).toBeVisible();
    await expect(row).toContainText("✓");

    // The card is derived from the placed draft, not from what the generator
    // was asked to do — so it is still right after a reload.
    await page.reload();
    await expect(
      outcomeCard(page).locator("li").filter({ hasText: description }),
    ).toContainText("✓");

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
    await expect(outcomeCard(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });
});

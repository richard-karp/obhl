/**
 * Path 26: what the generate form does with what it was told.
 *
 * Two opposite requirements, which is why they share a spec: **generate is
 * iterative** — a manager regenerates repeatedly, changing one field — so it
 * must keep every field it was given; **publish is terminal**, so it returns the
 * form to defaults and clears the season's stored manager requests.
 *
 * Driven through Fall 2026's setup page for the same reason
 * `11-schedule-builder` and `23-schedule-constraints` are: the generate flow
 * only exists on a season that has not started, and the active season is in the
 * past. Both pages render the same `ScheduleBuilderPanel`.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAsManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/dashboard");
}

async function goToFallSeasonSetup(page: Page) {
  await page.goto("/obhl/seasons");
  await page
    .getByRole("row", { name: /Fall 2026/ })
    .getByRole("link", { name: "Setup" })
    .click();
  await page.waitForURL(/\/seasons\//);
}

/**
 * Wait for the generate form, and fail IMMEDIATELY and by name if the builder
 * came up in either state that has no form on the page.
 *
 * ⛔ NOT A RETRY, AND NOT A LOOSENED ASSERTION. `publishMode` returns `locked`
 * for TWO reasons, and neither renders a generate form:
 *
 *   - `readFailed` — `getPublishState` fails closed, so any of its six reads
 *     erroring locks the panel and renders "This season's games couldn't be
 *     read". Transient, usually a database error under load.
 *   - `started` — the season is legitimately under way. Permanent, and it means
 *     this spec is pointed at the wrong season, not that anything broke.
 *
 * A plain `fill()` in either state waits on a locator that can never resolve
 * and reports only "waiting for getByLabel('First game night')" — on CI (run
 * 34055032836) that was a 12-minute `Test timeout of 720000ms exceeded`, which
 * tells the next person nothing about what actually happened.
 *
 * Racing the three locators is what makes the message honest: whichever the
 * page settled on is the one reported, in seconds. Both failures still fail the
 * run — they are real conditions and must not be swallowed — they just say so.
 *
 * ⛔ CALL IT BEFORE ANY GATE THAT READS THE PANEL, not inside the branch the
 * gate picks. Both locked cards make a `count()` probe answer wrongly, so a
 * guard behind one either never runs or runs too late to help.
 *
 * ⚠️ COPIED INTO EACH SPEC THAT NEEDS IT, AND IT HAS TO BE. A shared
 * `e2e/schedule-helpers.ts` was built and measured on 2026-09-06: every
 * relative TypeScript import dies at load with `context.conditions?.includes is
 * not a function`, sibling or not, with or without a `.js` specifier
 * (Playwright 1.61.0, Node 22.18.0). It is not "no module exists yet" and not
 * "only `src` is out of reach" — relative TS imports do not work here at all.
 * Change one copy, change them all; there are five.
 */
async function expectGenerateFormUsable(page: Page) {
  const firstNight = page.getByLabel("First game night");
  const readFailed = page.getByText("This season's games couldn't be read");
  const started = page.getByText("The season is under way");
  await expect(firstNight.or(readFailed).or(started).first()).toBeVisible();

  if (await readFailed.isVisible()) {
    throw new Error(
      "The schedule builder is in its read-failed state: getPublishState " +
        "reported readFailed, so publishMode locked the panel and there is no " +
        "generate form to fill. One of its parallel reads errored — check the " +
        "server log for 'publish state read failed'. This is usually a " +
        "transient database error under load, not a broken query.",
    );
  }

  if (await started.isVisible()) {
    throw new Error(
      "The schedule builder is locked because the season has STARTED, so " +
        "there is no generate form to fill. Not transient: a season is started " +
        "once it holds a published, non-draft game whose date has passed. " +
        "Either this spec is pointed at the wrong season, or its fixture " +
        "season has aged into the past — check the dates it seeds.",
    );
  }
}

/** See `11-schedule-builder.spec.ts` — Phase S runs five candidates. */
const AFTER_GENERATE = { timeout: 45_000 };

/** The first game night of the window these tests generate over. */
const FIRST_NIGHT = "2026-09-15";

/** Non-default ice times, so "still what I typed" cannot pass by accident. */
const SLOT_TIMES = "18:45, 20:00";

/** A Thursday inside the season, skipped — far enough out to not starve it. */
const SKIP_DAY = "24";
const SKIP_CHIP = "Sep 24";

/** The listed manager requests, and only those — see `23-schedule-constraints`. */
function requestList(page: Page) {
  return page
    .locator("li")
    .filter({ has: page.getByRole("button", { name: /^Remove request:/ }) });
}

/** Fill every field on the generate form with something that is not its default. */
async function fillEverything(page: Page) {
  // Same hazard as `29-schedule-repair`'s seeding: with the builder locked by a failed read
  // there is no form here at all, and a bare `fill` waits out the whole test
  // budget saying only "waiting for getByLabel".
  await expectGenerateFormUsable(page);
  await page.getByLabel("First game night").fill(FIRST_NIGHT);
  await page.getByLabel("Games per team").fill("4");
  await page.getByLabel(/Ice-time slots/).fill(SLOT_TIMES);
  await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
  await page.locator('label:has-text("Thu") input[name="weekdays"]').check();

  // The skip chips are React state, not an input — the discriminator the
  // reproduction turns on. If these survive a generate and the inputs above do
  // not, the cause is React's form reset rather than a remount.
  await page.getByRole("button", { name: "Pick dates" }).click();
  const popover = page.locator('[data-slot="popover-content"]');
  await popover
    .locator("button")
    .filter({ hasText: new RegExp(`^${SKIP_DAY}$`) })
    .first()
    .click();
  await popover.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText(SKIP_CHIP)).toBeVisible();
}

test.describe("Path 26 — the generate form's state", () => {
  // A generate can be ~25 s of search, and every test here runs one.
  test.describe.configure({ timeout: 150_000 });

  test.beforeEach(async ({ page }) => {
    await signedInAsManager(page);
    await goToFallSeasonSetup(page);
  });

  test("a generate leaves every field holding what was submitted", async ({
    page,
  }) => {
    await fillEverything(page);
    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);

    // Uncontrolled inputs.
    await expect(page.getByLabel("First game night")).toHaveValue(FIRST_NIGHT);
    await expect(page.getByLabel("Games per team")).toHaveValue("4");
    await expect(page.getByLabel(/Ice-time slots/)).toHaveValue(SLOT_TIMES);
    await expect(
      page.locator('label:has-text("Tue") input[name="weekdays"]'),
    ).toBeChecked();
    await expect(
      page.locator('label:has-text("Thu") input[name="weekdays"]'),
    ).toBeChecked();

    // React state.
    await expect(page.getByText(SKIP_CHIP)).toBeVisible();

    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  /**
   * ⛔ THE OTHER SUBMIT BUTTON IN THE SAME FORM, AND THE ONE THE USER ACTUALLY
   * COMPLAINED ABOUT.
   *
   * "Add request" is a submit button inside the generate form — it has to be,
   * because the season's game nights don't exist until the form above is filled
   * in. So adding a manager request submits the generate form, React 19 resets
   * every uncontrolled input on the way through, and the manager loses the five
   * fields they had just typed. Fixing only the Generate button left this half
   * of the bug in place.
   *
   * It is also the form's FIRST submit button in tree order, which makes it what
   * Enter does from any text field in the form.
   */
  test("adding a manager request keeps the fields already filled in", async ({
    page,
  }) => {
    await fillEverything(page);

    const teamSelect = page.getByLabel("Team", { exact: true });
    const teamValue = await teamSelect
      .locator("option")
      .nth(1)
      .getAttribute("value");
    await teamSelect.selectOption(teamValue!);
    await page.getByLabel("Request", { exact: true }).selectOption("slot_on");
    await page.getByLabel("Date", { exact: true }).fill("2026-09-22");
    await page.getByLabel("Ice time").fill("20:00");
    await page.getByRole("button", { name: "Add request" }).click();

    // The request landed…
    await expect(requestList(page)).toHaveCount(1);

    // …and took nothing with it.
    await expect(page.getByLabel("First game night")).toHaveValue(FIRST_NIGHT);
    await expect(page.getByLabel("Games per team")).toHaveValue("4");
    await expect(page.getByLabel(/Ice-time slots/)).toHaveValue(SLOT_TIMES);
    await expect(
      page.locator('label:has-text("Tue") input[name="weekdays"]'),
    ).toBeChecked();
    await expect(
      page.locator('label:has-text("Thu") input[name="weekdays"]'),
    ).toBeChecked();
    await expect(page.getByText(SKIP_CHIP)).toBeVisible();

    // Clean up: the season's stored requests outlive the test otherwise.
    await page
      .getByRole("button", { name: /^Remove request:/ })
      .first()
      .click();
    await expect(requestList(page)).toHaveCount(0);
  });

  test("a publish returns the form to defaults and clears the stored requests", async ({
    page,
  }) => {
    // A request to be cleared. `slot_on` for the reason `23-schedule-constraints`
    // gives: this seeded league has no bye budget at all.
    const teamSelect = page.getByLabel("Team", { exact: true });
    const teamValue = await teamSelect
      .locator("option")
      .nth(1)
      .getAttribute("value");
    await teamSelect.selectOption(teamValue!);
    await page.getByLabel("Request", { exact: true }).selectOption("slot_on");
    await page.getByLabel("Date", { exact: true }).fill("2026-09-22");
    await page.getByLabel("Ice time").fill("20:00");
    await page.getByRole("button", { name: "Add request" }).click();
    await expect(requestList(page)).toHaveCount(1);

    await fillEverything(page);
    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);

    await page.getByRole("button", { name: /^Publish/ }).click();
    // ⛔ The page, not the toast. A successful publish takes `draftCount` to 0,
    // and PublishControls is keyed on it — so it remounts, and its success toast
    // races that remount and often never renders at all. The live count is the
    // durable evidence.
    await expect(page.getByText(/^Published: \d+ games$/)).toBeVisible(
      AFTER_GENERATE,
    );

    // Everything back to its default: the chips gone, the ice times back to the
    // seeded three, the weekdays unchecked.
    await expect(page.getByText(SKIP_CHIP)).toHaveCount(0);
    await expect(page.getByLabel(/Ice-time slots/)).toHaveValue(
      "19:00, 20:15, 21:30",
    );
    await expect(
      page.locator('label:has-text("Tue") input[name="weekdays"]'),
    ).not.toBeChecked();

    // Server state, not form state: the rows are gone from the season.
    await expect(requestList(page)).toHaveCount(0);
    await page.reload();
    await expect(requestList(page)).toHaveCount(0);

    // ⛔ Put the fixture back. Fall 2026 is the season every schedule spec
    // generates against, and leaving it with a live schedule turns the builder's
    // mode from `published` to `replace` for the next run of `11` and `23`.
    // Removed through the app, not SQL — the seed's guards are the point.
    await page
      .getByRole("button", { name: "Remove published schedule" })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(page.getByText(/^Published: \d+ games$/)).toHaveCount(
      0,
      AFTER_GENERATE,
    );
  });
});

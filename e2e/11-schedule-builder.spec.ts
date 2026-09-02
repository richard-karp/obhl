/**
 * Path 17: Schedule Builder — page structure, the balanced generator, and
 * manager-only access.
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

/**
 * The builder's generate/publish flow only exists on a season that hasn't
 * started. The active season is in the past, so these tests drive Fall 2026
 * through its setup page, which renders the same ScheduleBuilderPanel.
 */
async function goToFallSeasonSetup(page: Page) {
  await page.goto("/obhl/manage/seasons");
  await page
    .getByRole("row", { name: /Fall 2026/ })
    .getByRole("link", { name: "Setup" })
    .click();
  await page.waitForURL(/\/seasons\//);
}

test("page loads with heading and active season description", async ({ page }) => {
  await signedInAs(page, "Manager");
  await page.goto("/obhl/manage/schedule-builder");
  await expect(page.getByText("Schedule Builder")).toBeVisible();
  await expect(page.getByText(/active/)).toBeVisible();
});

test("scorekeeper cannot reach /schedule-builder", async ({ page }) => {
  await signedInAs(page, "Scorekeeper");
  await page.goto("/obhl/manage/schedule-builder");
  await expect(page).toHaveURL("/");
});

/**
 * How long an assertion may wait on a generate.
 *
 * `playwright.config.ts` sets a 15s assertion timeout and reasons it from the
 * generator's `OBHL_SLOT_BUDGET_MS` (5s). That is one budget short of what a
 * generate actually spends: `assignNights` runs Phase S at FIVE candidates —
 * 160, 140 on three seeds, then 200 — each on its own budget, so the search
 * alone can reach ~25s before anything renders (SCHEDULE_HANDOFF §5).
 *
 * The gap hid because generate time is hardware-bound: this file's spacing test
 * takes ~3s on a laptop, ~10s on a quiet CI runner, and blew the 15s ceiling on
 * a loaded one. Raising the global timeout instead would slow every genuine
 * failure in the suite by 30s, which the config comment explicitly warns off.
 *
 * Applies ONLY to assertions waiting on a generate. Anything else that needs
 * this long is a bug, not a slow search.
 */
const AFTER_GENERATE = { timeout: 45_000 };

test.describe("Path 17 — Schedule Builder", () => {
  // Two of these tests generate twice, and a generate can be ~25s of search on
  // a slow runner — the 60s default would be the next thing to fail.
  test.describe.configure({ timeout: 150_000 });

  test.beforeEach(async ({ page }) => {
    await signedInAs(page, "Manager");
    await goToFallSeasonSetup(page);
  });

  test("generate form has the length toggle and core fields", async ({ page }) => {
    await expect(page.getByText("Generate a balanced schedule")).toBeVisible();
    await expect(page.getByLabel("First game night")).toBeVisible();
    await expect(page.getByRole("button", { name: "By games per team" })).toBeVisible();
    await expect(page.getByRole("button", { name: "By end date" })).toBeVisible();
    await expect(page.getByLabel("Games per team")).toBeVisible();
    await expect(page.getByLabel(/Ice-time slots/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate schedule" })).toBeVisible();
  });

  test("length toggle swaps games-per-team for an end date", async ({ page }) => {
    await expect(page.getByLabel("Games per team")).toBeVisible();
    await page.getByRole("button", { name: "By end date" }).click();
    await expect(page.getByLabel("Last regular-season night")).toBeVisible();
    await expect(page.getByLabel("Games per team")).toHaveCount(0);
  });

  test("weekday checkboxes are all present", async ({ page }) => {
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      await expect(page.getByText(day, { exact: true })).toBeVisible();
    }
  });

  test("one-off scheduling has moved off the builder, behind a link", async ({
    page,
  }) => {
    // The builder is pre-season only: draft → review → publish. Scheduling a
    // one-off is a mid-season edit to published games and lives on its own page.
    await expect(
      page.getByText("Schedule a one-off game (tournament final / semifinals)"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Schedule a one-off game" }),
    ).toBeVisible();
  });

  test("empty draft state shows before a draft is generated", async ({ page }) => {
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("generates a balanced draft with equal games per team", async ({ page }) => {
    // These tests drive Fall 2026 (Sep 15 2026 – Mar 31 2027), not the active
    // season — start on its first night. A date outside the window still
    // generates (drafts aren't bounded by the season start), so this reads as
    // passing while drafting a schedule months before the season it belongs to.
    await page.getByLabel("First game night").fill("2026-09-15");
    await page.getByLabel("Games per team").fill("4");
    // Two game nights so weekday balance is exercised.
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();

    await page.getByRole("button", { name: "Generate schedule" }).click();

    // Draft preview appears: balance report and a Publish button.
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);
    await expect(page.getByRole("button", { name: /Publish \d+ games/ })).toBeVisible();

    // Every team's GP cell should read 4 (equal games per team). Scoped to the
    // Balance report card: the season setup page also has a team roster table
    // above it, and an unscoped `tbody tr` selector would match both.
    const balanceReportCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Balance report" });
    const gpCells = balanceReportCard.locator("tbody tr td:nth-child(2)");
    const count = await gpCells.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i++) {
      await expect(gpCells.nth(i)).toHaveText("4");
    }

    // Clean up so later runs still see the empty-draft state.
    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("a generate reports its result instead of finishing in silence", async ({
    page,
  }) => {
    // The *result*, not the progress bar. This fixture is sparse and generates
    // in about 0.4 s, so asserting the bar would race its own disappearance —
    // the bar is verified by eye against a full season, where the run takes
    // ~26 s. What is covered here is the half that used to be missing
    // entirely: generateSchedule returned void, so a refusal and a slow run
    // were indistinguishable.
    await page.getByLabel("First game night").fill("2026-09-15");
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();

    await expect(
      page.getByText(/Generated a \d+-game draft schedule/),
    ).toBeVisible(AFTER_GENERATE);

    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("a generate with no game nights says so rather than doing nothing", async ({
    page,
  }) => {
    // The refusal this feature exists for. With no weekday checked the action
    // bails before it touches the database; before it returned a state, the
    // button simply went back to idle and the manager was left guessing
    // whether the generator had run and failed or never started.
    await page.getByLabel("First game night").fill("2026-09-15");
    await page.getByLabel("Games per team").fill("4");

    await page.getByRole("button", { name: "Generate schedule" }).click();

    await expect(
      page.getByText("Pick at least one game night of the week."),
    ).toBeVisible();
    // And nothing was generated.
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("spacing checks report every goal the generator models", async ({ page }) => {
    // The generator models four goals the panel is the only place a manager can
    // see. They are computed server-side per draft, so nothing below asserts a
    // *value* — a four-game fixture is not the reference season and its numbers
    // are its own. What is asserted is that each check reaches the screen, which
    // is what nothing covered before.
    await page.getByLabel("First game night").fill("2026-09-15");
    await page.getByLabel("Games per team").fill("4");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText("Balance report")).toBeVisible(AFTER_GENERATE);

    await expect(page.getByText("Spacing checks")).toBeVisible();
    for (const label of [
      "Teams byeing back-to-back game nights",
      "Matchups off an even weekday split",
      "Uneven ice time within a night of the week",
      "Three games in a row in one ice time",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    // No assertion here on what "Matchups off an even weekday split" *reads*.
    // The row once showed `pairingWeekdayExcess`, a summed squared deviation —
    // 8 where two matchups were off, and 3.7872 on a season whose weekday night
    // counts do not divide evenly — and a guard against that regressing belongs
    // where it can bite. It cannot bite here: a fixture this small reaches a
    // perfect split, so the score and the count are both 0 and both render as a
    // tick. Tried it, reverted the row to the score, and this test still passed.
    // The real guard is `spacingReport — pairingsOffWeekdaySplit` in
    // `spacing.test.ts`, which builds the uneven cadence that separates them.

    // Informational, and deliberately not a check: it has no zero to reach, so
    // it sits outside the tick list with its own explanation.
    await expect(page.getByText(/Longest stretch without a game/)).toBeVisible();

    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("republishing replaces the schedule instead of stacking a second one", async ({
    page,
  }) => {
    // The reported bug: generate + publish twice left the season holding two
    // complete overlapping schedules, both live in the exports and standings.
    const generate = async () => {
      await page.getByLabel("First game night").fill("2026-09-15");
      await page.getByLabel("Games per team").fill("4");
      await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
      await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
      await page.getByRole("button", { name: "Generate schedule" }).click();
    };

    await generate();
    const publishButton = page.getByRole("button", { name: /Publish \d+ games/ });
    await expect(publishButton).toBeVisible(AFTER_GENERATE);
    const published = Number((await publishButton.textContent())!.match(/\d+/)![0]);
    await publishButton.click();

    // Rendered state, not the toast — the toast auto-dismisses.
    await expect(page.getByText(`Published: ${published} games`)).toBeVisible();

    // The published state has to say how to change the schedule. Without this
    // line the page is a count plus an empty state that says "Generate one
    // above to preview it here before publishing" — neither of which tells a
    // manager that generating a draft is the precondition for replacing.
    await expect(
      page.getByText(/To change the schedule, generate a new one above/),
    ).toBeVisible();

    // Second pass — the button must offer a replace, not another publish.
    await generate();
    await expect(
      page.getByRole("button", { name: "Replace published schedule" }),
    ).toBeVisible(AFTER_GENERATE);
    await expect(page.getByRole("button", { name: /Publish \d+ games/ })).toHaveCount(0);

    // The live schedule stays visible in replace mode. It used to be suppressed
    // here, leaving the button label as the only evidence on the page that a
    // published schedule existed at all — on the screen that deletes it.
    await expect(page.getByText(`Published: ${published} games`)).toBeVisible();

    await page.getByRole("button", { name: "Replace published schedule" }).click();
    await expect(page.getByText("Replace the published schedule?")).toBeVisible();
    await expect(page.getByText(`This deletes ${published} live games`)).toBeVisible();
    // The range is how a manager verifies *which* schedule is about to go, so
    // it's in the same long form as the rest of the panel rather than the raw
    // ISO dates this dialog used to show. Asserted by shape, and always
    // together with the sentence around it — a bare date also appears in the
    // page header and on every night heading behind the dialog. Matching the
    // literal formatted date instead would pin this test to both the fixture's
    // start date and formatLongDate's exact output.
    await expect(
      page.getByText(/This deletes \d+ live games \(.+ – .+\)/),
    ).toBeVisible();
    await expect(
      page.getByText(/This deletes \d+ live games \(\d{4}-\d{2}-\d{2}/),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Replace", exact: true }).click();

    // One schedule's worth, not two. The draft is consumed, so the page falls
    // back to "published" mode with the same count it had before.
    await expect(page.getByText(`Published: ${published} games`)).toBeVisible();
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });

  test("a started season locks the builder", async ({ page }) => {
    // The active Spring 2026 season is in the past, so it has started.
    await page.goto("/obhl/manage/schedule-builder");
    await expect(page.getByText("The season is under way")).toBeVisible();
    await expect(page.getByText("Generate a balanced schedule")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Generate schedule" }),
    ).toHaveCount(0);
    // Removal is gated behind the same mode, so it must be absent here too.
    await expect(
      page.getByRole("button", { name: "Remove published schedule" }),
    ).toHaveCount(0);
  });

  test("removing a published schedule leaves the season with no games", async ({
    page,
  }) => {
    // Order-independent on purpose. Playwright runs this file with workers: 1,
    // so the republish test above normally leaves Fall 2026 already published
    // and this branch does not run — but the test then still works under `-g`
    // in isolation, or if the tests above are reordered.
    // Wait for the panel to have rendered before probing. `count()` resolves
    // immediately, so probing first can read 0 on a season that *is* published
    // and send this down the publish branch — where the button reads "Replace
    // published schedule" and the publish click times out instead.
    await expect(
      page.getByText(/Published: \d+ games|No draft schedule/).first(),
    ).toBeVisible();

    const removeButton = page.getByRole("button", {
      name: "Remove published schedule",
    });
    if ((await removeButton.count()) === 0) {
      await page.getByLabel("First game night").fill("2026-09-15");
      await page.getByLabel("Games per team").fill("4");
      await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
      await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
      await page.getByRole("button", { name: "Generate schedule" }).click();
      await page.getByRole("button", { name: /Publish \d+ games/ }).click();
    }

    await expect(removeButton).toBeVisible();

    await removeButton.click();
    await expect(page.getByText("Remove the published schedule?")).toBeVisible();
    // Asserted by shape. The dialog deliberately carries no game count — a
    // pre-start removal destroys nothing that can't be regenerated — so there
    // is no number here to pin the test to.
    await expect(
      page.getByText(/The season will have no games until you generate/),
    ).toBeVisible();
    // `exact` matters: without it this also matches the "Remove published
    // schedule" trigger behind the dialog.
    await page.getByRole("button", { name: "Remove", exact: true }).click();

    // Back to zero. All three assertions are needed: the count going away shows
    // the games are gone, the control going away shows the mode moved, and the
    // empty state shows the panel recovered rather than rendering nothing.
    await expect(page.getByText(/Published: \d+ games/)).toHaveCount(0);
    await expect(removeButton).toHaveCount(0);
    await expect(page.getByText("No draft schedule")).toBeVisible();
  });
});

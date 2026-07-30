/**
 * Path 17: Schedule Builder — page structure, the balanced generator, and
 * manager-only access.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  await page.waitForURL("/dashboard");
}

/**
 * The builder's generate/publish flow only exists on a season that hasn't
 * started. The active season is in the past, so these tests drive Fall 2026
 * through its setup page, which renders the same ScheduleBuilderPanel.
 */
async function goToFallSeasonSetup(page: Page) {
  await page.goto("/seasons");
  await page
    .getByRole("row", { name: /Fall 2026/ })
    .getByRole("link", { name: "Setup" })
    .click();
  await page.waitForURL(/\/seasons\//);
}

test("page loads with heading and active season description", async ({ page }) => {
  await signedInAs(page, "Manager");
  await page.goto("/schedule-builder");
  await expect(page.getByText("Schedule Builder")).toBeVisible();
  await expect(page.getByText(/active/)).toBeVisible();
});

test("scorekeeper cannot reach /schedule-builder", async ({ page }) => {
  await signedInAs(page, "Scorekeeper");
  await page.goto("/schedule-builder");
  await expect(page).toHaveURL(/login|dashboard/);
});

test.describe("Path 17 — Schedule Builder", () => {
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
    await expect(page.getByText("Balance report")).toBeVisible();
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
    await expect(publishButton).toBeVisible();
    const published = Number((await publishButton.textContent())!.match(/\d+/)![0]);
    await publishButton.click();

    // Rendered state, not the toast — the toast auto-dismisses.
    await expect(page.getByText(`Published: ${published} games`)).toBeVisible();

    // Second pass — the button must offer a replace, not another publish.
    await generate();
    await expect(
      page.getByRole("button", { name: "Replace published schedule" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Publish \d+ games/ })).toHaveCount(0);

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
    await page.goto("/schedule-builder");
    await expect(page.getByText("The season is under way")).toBeVisible();
    await expect(page.getByText("Generate a balanced schedule")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Generate schedule" }),
    ).toHaveCount(0);
  });
});

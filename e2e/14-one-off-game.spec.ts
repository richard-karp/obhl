/**
 * Path 22: Mid-season one-off games (tournament final / semifinals).
 *
 * The seeded season's games are all in the past, so every night is locked and
 * there's nothing to take over. This spec therefore builds its own season with
 * future dates first. It runs late on purpose: publishing games would otherwise
 * disturb specs 12–13, which read the seeded schedule.
 *
 * It is no longer LAST, though, and that used to matter. Making its own season
 * active left every later spec looking at a season with no rosters and no
 * games — the roster pages simply render "No players yet", which reads like a
 * broken page rather than a leaked fixture. `afterAll` below puts the seeded
 * season back.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/** Service-role client, for putting the seeded season back afterwards. */
function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const SEASON = "One-Off Test 2027";

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

/** A live season with future game nights, published. Idempotent across runs. */
async function seedFutureSeason(page: Page) {
  await page.goto("/obhl/seasons");
  // Match the table row, not the success banner, which also carries the name.
  const row = page.getByRole("row", { name: new RegExp(SEASON) });
  if ((await row.count()) === 0) {
    await page.getByLabel("Name").fill(SEASON);
    await page.getByLabel("Season starts").fill("2027-01-05");
    await page.getByLabel("Season ends (incl. playoffs)").fill("2027-06-30");
    await page.getByRole("button", { name: /Create season/i }).click();
    // Wait for the redirect, then re-navigate before looking for the row.
    //
    // `createSeason` sends the browser to the new season's setup page, so
    // asserting anything on /seasons straight after the click is a race between
    // that navigation and the revalidation — the row assertion that used to be
    // here won it most of the time and lost it in a full run. The success toast
    // is no better: it renders on the page being navigated away from.
    await expect(page).toHaveURL(/\/seasons\/[0-9a-f-]{36}/);
    await page.goto("/obhl/seasons");
    await expect(row).toBeVisible();
  }

  // Re-navigate before clicking through: creating the season revalidates
  // /seasons, and clicking into a table that's mid-re-render detaches the link.
  await page.goto("/obhl/seasons");
  await row.getByRole("link", { name: "Setup" }).click();
  await expect(page).toHaveURL(/\/seasons\//);

  // Enroll the same teams as the seeded season.
  if ((await page.locator("table tbody tr").count()) === 0) {
    await page
      .getByRole("button", { name: "Same teams as last season" })
      .click();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  }

  // Make it the live season from the list, where the row scopes the button, and
  // confirm it took — the builder works on whichever season is active, so
  // getting this wrong silently generates against the wrong one.
  await page.goto("/obhl/seasons");
  const setActive = row.getByRole("button", { name: "Set active" });
  if ((await setActive.count()) > 0) await setActive.click();
  // The list only renders that button for inactive seasons, so its absence is
  // proof the switch landed. Don't assert on the "Active" badge text: getByText
  // matches case-insensitive substrings, so it also matches "Set active" and
  // would pass before the click took — and `setActiveSeason` clears every
  // season before setting one, so racing it lands on "No active season".
  await expect(setActive).toHaveCount(0);

  await page.goto("/obhl/schedule-builder");
  await expect(page.getByText(`${SEASON} (active)`)).toBeVisible();
  if ((await page.getByText("No draft schedule").count()) > 0) {
    await page.getByLabel("First game night").fill("2027-01-05");
    await page.getByLabel("Games per team").fill("6");
    await page.locator('label:has-text("Tue") input[name="weekdays"]').check();
    await page.locator('label:has-text("Thu") input[name="weekdays"]').check();
    await page.getByRole("button", { name: "Generate schedule" }).click();
    // Generation is a solver, not a query: it runs to a wall-clock budget and is
    // the slowest thing in the suite, so it needs more than the default timeout.
    await expect(page.getByText("Balance report")).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: /Publish \d+ games/ }).click();
    // Wait for the publish to land. Navigating away while the action is still in
    // flight leaves the one-off page reading a season whose games are all still
    // drafts, and it renders "No published schedule" instead of the form. The
    // panel drops back to its empty state once the drafts are live.
    await expect(page.getByText("No draft schedule")).toBeVisible();
  }
}

test.describe("Path 22 — one-off games", () => {
  /**
   * Hand obhl back to the seeded season.
   *
   * Not a delete: the one-off season and its published schedule are what these
   * tests built and are worth keeping for a post-mortem. Only which season is
   * ACTIVE is restored, because that is the single piece of state every later
   * spec reads. A partial unique index allows one active season per league, and
   * `is_active = true` on the seeded row clears the other by itself.
   */
  test.afterAll(async () => {
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    if (!league) return;
    await db
      .from("seasons")
      .update({ is_active: false })
      .eq("league_id", league.id)
      .eq("name", SEASON);
    await db
      .from("seasons")
      .update({ is_active: true })
      .eq("league_id", league.id)
      .eq("name", "Spring 2026");
  });

  test("manager can schedule a one-off and pick how the season absorbs it", async ({
    page,
  }) => {
    test.slow();
    await signedInAs(page, "Manager");
    await seedFutureSeason(page);

    await page.goto("/obhl/schedule-builder/one-off");
    await expect(page.getByText("Schedule a one-off game")).toBeVisible();

    // The date field stays shut until the teams are known — eligibility is a
    // function of who's already playing that night.
    const date = page.getByLabel("Date");
    await expect(date).toBeDisabled();

    const options = await page
      .getByLabel("Team 1")
      .first()
      .locator("option")
      .all();
    const teamValues: string[] = [];
    for (const o of options) {
      const v = await o.getAttribute("value");
      if (v) teamValues.push(v);
    }
    expect(teamValues.length).toBeGreaterThan(1);

    await page.getByLabel("Team 1").first().selectOption(teamValues[0]);
    await page.getByLabel("Team 2").first().selectOption(teamValues[1]);
    await expect(date).toBeEnabled();

    // Only nights where both teams already play are offered.
    const dateOptions = await date.locator("option:not([disabled])").count();
    expect(dateOptions).toBeGreaterThan(0);
    await date.selectOption({ index: 1 });

    await page.getByRole("button", { name: "Preview" }).click();

    // Either there's a repair to choose between, or the two teams already meet
    // that night and it's just a label — both are valid outcomes.
    const picker = page.getByText("Pick how to absorb it");
    const relabel = page.getByText("Nothing to repair");
    await expect(picker.or(relabel)).toBeVisible({ timeout: 30000 });

    if (await picker.isVisible()) {
      await expect(
        page.getByText(/opponent balance restored/).first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "Apply this plan" }).click();
    } else {
      await page.getByRole("button", { name: "Label the game" }).click();
    }

    await expect(
      page.getByText(/Scheduled the game|Labelled the game/),
    ).toBeVisible({
      timeout: 30000,
    });
  });

  test("scorekeeper cannot reach the one-off page", async ({ page }) => {
    await signedInAs(page, "Scorekeeper");
    await page.goto("/obhl/schedule-builder/one-off");
    await expect(page).toHaveURL("/");
  });
});

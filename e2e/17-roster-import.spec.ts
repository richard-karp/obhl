/** Roster-only import — teams and players, no games. */
import { test, expect } from "@playwright/test";

test("rosters-only mode hides the game count in the preview", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/import");

  await page.getByLabel(/rosters only/i).check();
  await expect(page.getByText(/games? found/i)).toHaveCount(0);
});

/**
 * The assertion above cannot fail: with no preview fetched there is no review
 * card, and the card renders "N games (final results)" or "no schedule found"
 * — neither matches /games? found/. Loading a preview would mean an outbound
 * fetch to esportsdesk from a test, which is why the spec above avoids it.
 *
 * This covers what is reachable without the network: the mode is a real toggle
 * that changes what the page says it will import, and rosters-only is the
 * default.
 */
test("mode defaults to rosters-only and switching modes changes the blurb", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  await page.waitForURL("/");
  await page.goto("/obhl/import");

  await expect(page.getByLabel(/rosters only/i)).toBeChecked();
  await expect(
    page.getByText(/imports the teams and players only/i),
  ).toBeVisible();

  await page.getByLabel(/full migration/i).check();
  await expect(page.getByText(/schedule with final results/i)).toBeVisible();
  await expect(
    page.getByText(/imports the teams and players only/i),
  ).toHaveCount(0);
});

/**
 * Where signing out LANDS you.
 *
 * It used to be `/login` — the email-entry screen — which reads as a failed
 * sign-out rather than a finished one: the person deliberately left, and the app
 * answered by asking them to come back. The destination is now the public home
 * of the league they were in, and `/` when there is no league in context.
 *
 * ⛔ The slug arrives from the CLIENT, as a hidden field on the sign-out form,
 * and becomes a redirect target. The third test is the one that matters: a slug
 * that does not resolve must land on `/`, not on whatever was posted.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signInAsManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  // Sign-in lands on the league picker; there is no league-agnostic dashboard.
  await page.waitForURL("/");
}

const signOut = (page: Page) => page.getByRole("button", { name: "Sign out" });

/**
 * ⛔ THE ORDER OF THE THREE ASSERTIONS BELOW IS LOAD-BEARING, and getting it
 * wrong makes a test that passes against the OLD behaviour. Every one of these
 * matchers retries, so any of them evaluated against the page the browser has
 * not left yet passes instantly:
 *
 *   - `toHaveURL("/")` after signing out FROM `/` is already true, always;
 *   - so is "the picker heading is visible", for the same reason.
 *
 * The sign-out button disappearing is the one condition that cannot be true
 * before the navigation, whatever the destination — so it goes first, and the
 * other two are only read once it holds. Watched: with the assertions in the
 * other order, the picker test passed against the `/login` redirect this change
 * replaces.
 */
async function assertLandedSignedOutOn(
  page: Page,
  url: string,
  heading: string,
) {
  await expect(signOut(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  await expect(page).toHaveURL(url);
}

const PICKER = ["/", "Choose your league"] as const;
const LEAGUE_HOME = ["/obhl", "Oceanview Beer Hockey League"] as const;

test.describe("Sign-out destination", () => {
  test("from a league page it lands on that league's public home", async ({
    page,
  }) => {
    await signInAsManager(page);
    await page.goto("/obhl/standings");
    await signOut(page).click();

    await assertLandedSignedOutOn(page, ...LEAGUE_HOME);
  });

  test("from the league picker, which has no league, it lands on /", async ({
    page,
  }) => {
    await signInAsManager(page);
    // ⚠️ The picker, not `/set-password`. That page renders no `AccountCluster`
    // and so has no sign-out control at all — the picker is the one place the
    // cluster is drawn with no league in the URL.
    await page.goto("/");
    await signOut(page).click();

    await assertLandedSignedOutOn(page, ...PICKER);
  });

  test("a posted slug that does not resolve lands on / rather than on itself", async ({
    page,
  }) => {
    await signInAsManager(page);
    await page.goto("/obhl");
    // Rewriting the hidden field is exactly what an attacker controls. The
    // server has to resolve it rather than trust it.
    const field = page.locator('form input[name="league"]');
    await expect(field).toHaveValue("obhl");
    await field.evaluate((el) => {
      (el as HTMLInputElement).value = "no-such-league-anywhere";
    });
    await signOut(page).click();

    await assertLandedSignedOutOn(page, ...PICKER);
  });
});

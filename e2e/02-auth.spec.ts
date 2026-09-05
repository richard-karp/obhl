/**
 * Path 6: Auth — login and session management.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(
  page: Page,
  role: "Manager" | "Scorekeeper" | "Captain",
) {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  // Sign-in lands on the league picker — there is no league-agnostic dashboard
  // any more. Every caller below expects to be inside a league's manage tools.
  await page.waitForURL("/");
  await page.goto("/obhl/manage/dashboard");
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("/login");
}

test.describe("Path 6 — Auth / Login / Session", () => {
  test("dev quick sign-in lands on the league picker, not a dead /dashboard", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Manager" }).click();
    await page.waitForURL("/");
    await expect(
      page.getByRole("heading", { name: "Choose your league" }),
    ).toBeVisible();
  });

  test("the manage dashboard shows the manager's tools", async ({ page }) => {
    await signedInAs(page, "Manager");
    await expect(page.getByRole("heading", { name: "Manage" })).toBeVisible();
    await expect(page.getByText("People & Roles").first()).toBeVisible();
    await expect(page.getByText("Seasons").first()).toBeVisible();
  });

  test("sign out returns to /login", async ({ page }) => {
    await signedInAs(page, "Manager");
    await signOut(page);
    await expect(page).toHaveURL("/login");
    await expect(
      page.getByRole("heading", { name: "Staff sign in" }),
    ).toBeVisible();
  });

  test("unauthenticated access to a manage route redirects to /login", async ({
    page,
  }) => {
    await page.goto("/obhl/manage/seasons");
    await expect(page).toHaveURL(/\/login/);
  });

  test("scorekeeper dashboard shows Score Games card but not People & Roles", async ({
    page,
  }) => {
    await signedInAs(page, "Scorekeeper");
    await expect(page.getByText("Score Games").first()).toBeVisible();
    // People & Roles card should not appear on a scorekeeper dashboard
    const peopleCard = page.locator('[data-slot="card-title"]', {
      hasText: "People & Roles",
    });
    await expect(peopleCard).not.toBeVisible();
  });

  test("captain dashboard shows team card", async ({ page }) => {
    await signedInAs(page, "Captain");
    await expect(page.getByText(/captain the/i)).toBeVisible();
  });
});

/**
 * The chrome outside the manage tools. A signed-in manager used to see exactly
 * what a stranger saw on every public page — no badge, no route to their tools,
 * no way out — which is the confusion the account cluster exists to end.
 */
test.describe("Path 6b — Auth-aware chrome", () => {
  test("a signed-in manager carries their badge onto the public site", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Manager" }).click();
    await page.waitForURL("/");

    // The picker: the page sign-in actually lands on, and the one page with no
    // league in its URL.
    await expect(page.getByText("Manager").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.getByRole("link", { name: "Manage" }).click();
    await expect(page).toHaveURL(/\/manage\/dashboard$/);

    // And a public league page, which has its own header.
    await page.goto("/obhl/standings");
    await expect(page.getByText("Manager").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Manage" })).toHaveAttribute(
      "href",
      "/obhl/manage/dashboard",
    );
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("an anonymous visitor sees none of it", async ({ page }) => {
    for (const url of ["/", "/obhl/standings"]) {
      await page.goto(url);
      await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(
        0,
      );
      await expect(page.getByRole("link", { name: "Manage" })).toHaveCount(0);
      await expect(page.getByText("Manager")).toHaveCount(0);
    }
  });

  test("the public header does not overflow at md, signed in or out", async ({
    page,
  }) => {
    // `md` is where the inline nav appears and where the bar has always been at
    // its tightest — see the measurement in `site-header.tsx`. Signed in the
    // links drop to their own row instead of sharing it with the account
    // controls, which is what keeps this true.
    const fits = () =>
      page.evaluate(() => {
        const el = document.documentElement;
        return el.scrollWidth <= el.clientWidth;
      });

    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto("/obhl/standings");
    expect(await fits()).toBe(true);

    await page.goto("/login");
    await page.getByRole("button", { name: "Manager" }).click();
    await page.waitForURL("/");
    await page.goto("/obhl/standings");
    expect(await fits()).toBe(true);
    await expect(page.getByText("Manager").first()).toBeVisible();
  });
});

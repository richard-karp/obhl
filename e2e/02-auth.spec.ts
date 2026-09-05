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
  await page.goto("/obhl/dashboard");
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
    await page.goto("/obhl/seasons");
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
 * The role badge specifically, not the word anywhere on the page. As a bare
 * `getByText("Manager")` this matched any future content containing the word —
 * a staff name, an announcement — so the absence assertions below would have
 * started failing on unrelated copy.
 */
const badge = (page: Page) =>
  page.locator('[data-slot="badge"]', { hasText: "Manager" });

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
    await expect(badge(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.getByRole("link", { name: "Manage" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    // And a public league page, which has its own header.
    await page.goto("/obhl/standings");
    await expect(badge(page)).toBeVisible();
    await expect(page.getByRole("link", { name: "Manage" })).toHaveAttribute(
      "href",
      "/obhl/dashboard",
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
      await expect(badge(page)).toHaveCount(0);
    }
  });

  test("the public header does not overflow at md, signed in or out", async ({
    page,
  }) => {
    // `md` is where the inline nav appears and where the bar has always been at
    // its tightest — see the measurement in `site-header.tsx`. Signed in the
    // links drop to their own row instead of sharing it with the account
    // controls, which is what keeps this true.
    //
    // Measured on the BAR, not on the document. The document is the weaker
    // subject: `NavLinks` carries `overflow-x-auto`, and an overflowing flex
    // item with its own scroller can absorb the excess by clipping its links
    // rather than pushing the page sideways — which is the mechanism
    // `manage-nav.tsx` documents. The bar's own `scrollWidth` sees the overflow
    // either way.
    //
    // Controlled 2026-09-05: with the signed-in class strings reverted to `md:`,
    // this fails on the signed-in leg. It is not a check that cannot fail.
    //
    // ⚠️ The ANONYMOUS leg has no such demonstration, and cannot easily have one:
    // anonymous is the state the layout was already sized for, so there is no
    // edit that makes it overflow without changing what it is testing. Read it as
    // a regression guard on a measured-good state, not as a proven-sensitive
    // assertion.
    // Three subjects, because each can absorb what the one above it would show.
    // The document is the weakest: the bar can overflow while the page does not.
    // The bar is stronger, but `NavLinks` is an `overflow-x-auto` scroller, and a
    // scroll container contributes zero min-content — so its wrapper can shrink
    // to nothing and CLIP THE LINKS while the bar still reports no overflow.
    // Asserting on the nav's own scroller is what closes that, and it is the
    // mechanism `manage-nav.tsx` documents.
    const fits = () =>
      page.evaluate(() => {
        const bar = document.querySelector("header > div");
        if (!bar) throw new Error("header bar not found");
        const nav = document.querySelector("header nav");
        if (!nav) throw new Error("header nav not found");
        return (
          bar.scrollWidth <= bar.clientWidth &&
          nav.scrollWidth <= nav.clientWidth &&
          document.documentElement.scrollWidth <=
            document.documentElement.clientWidth
        );
      });

    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto("/obhl/standings");
    expect(await fits()).toBe(true);

    await page.goto("/login");
    await page.getByRole("button", { name: "Manager" }).click();
    await page.waitForURL("/");
    await page.goto("/obhl/standings");
    expect(await fits()).toBe(true);
    await expect(badge(page)).toBeVisible();
  });
});

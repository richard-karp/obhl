/**
 * One site, not two.
 *
 * There used to be two headers wearing different clothes: `SiteHeader` on the
 * public pages, offering a "Manage" cross-link, and `ManageNav` on the staff
 * pages, offering "View site". A manager therefore had a mode to be in or out
 * of, and two navigations that named the same URLs differently. Now there is one
 * header on every page under `/<league>`, with the staff link row beneath it for
 * anyone who belongs to the league.
 *
 * ⛔ THE CHROME IS NOT THE GUARD. Nothing here asserts that a page is
 * unreachable because a nav stopped pointing at it — a URL typed by hand still
 * reaches it, and the page's own `requireLeagueManager` is what refuses. The
 * last test in this file is that assertion, kept beside the chrome ones on
 * purpose: the chrome moving must not be mistaken for the guard moving.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const staffRow = (page: Page) =>
  page.getByRole("navigation", { name: "Staff tools" });
const leagueNav = (page: Page) =>
  page.getByRole("navigation", { name: "League" });

async function signInAs(page: Page, label: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForURL("/");
}

test.describe("One chrome everywhere", () => {
  test("a manager sees the same header, with a staff row, on public and staff pages alike", async ({
    page,
  }) => {
    await signInAs(page, "Manager");

    for (const url of [
      "/obhl", // public league home
      "/obhl/standings", // public
      "/obhl/dashboard", // staff
      "/obhl/seasons", // staff
    ]) {
      await page.goto(url);
      // The public header's own nav, named "League" — on the staff pages too,
      // which is the whole change.
      await expect(leagueNav(page).first()).toBeVisible();
      await expect(staffRow(page)).toBeVisible();
      await expect(staffRow(page).getByRole("link", { name: "Seasons" })).toBeVisible();
      // The URL is untouched by any of this. `(public)` and `(manage)` are route
      // groups and never appear in a path; moving the chrome moves no page.
      await expect(page).toHaveURL(url);
    }
  });

  test("no Manage link and no View site link exist anywhere", async ({
    page,
  }) => {
    await signInAs(page, "Manager");
    for (const url of ["/", "/obhl", "/obhl/standings", "/obhl/dashboard"]) {
      await page.goto(url);
      await expect(page.getByRole("link", { name: "Manage", exact: true })).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "View site", exact: true }),
      ).toHaveCount(0);
    }
  });

  test("an anonymous visitor gets no staff row and the header they always had", async ({
    page,
  }) => {
    for (const url of ["/obhl", "/obhl/standings", "/obhl/schedule"]) {
      await page.goto(url);
      await expect(leagueNav(page).first()).toBeVisible();
      await expect(staffRow(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    }
  });

  test("a manager of another league browsing this one gets no staff row", async ({
    page,
  }) => {
    // ⚠️ MEMBERSHIP, NOT ROLE. `single-league-lead@` is a `league_manager` — the
    // instance-wide role is the same one the Oceanview manager holds — but they
    // belong to Harbor only. Gating the row on `user.role` would hand them
    // Oceanview's tools, every one of which redirects them straight back out.
    await signInAs(page, "One-league mgr");

    await page.goto("/obhl");
    await expect(leagueNav(page).first()).toBeVisible();
    await expect(staffRow(page)).toHaveCount(0);
    // Still signed in, though — the account half of the cluster is theirs
    // wherever they are.
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    // And the league they DO belong to still offers the row.
    await page.goto("/harbor");
    await expect(staffRow(page)).toBeVisible();
  });

  test("a page that left the nav is still refused by its own guard", async ({
    page,
  }) => {
    await signInAs(page, "One-league mgr");
    // No staff row on Oceanview offers this URL. Typing it anyway must still be
    // refused by `requireLeagueManager` on the page, which redirects to the
    // picker — the chrome was never what protected it.
    await page.goto("/obhl/seasons");
    await expect(page).toHaveURL("/");
  });
});

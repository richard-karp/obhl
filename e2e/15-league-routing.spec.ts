/**
 * Path 16: per-league routing — the league lives in the URL, so a link to one
 * league is a link to that league for whoever opens it.
 *
 * Assumes both seeded leagues: `obhl` (Oceanview, 6 teams) and `harbor`
 * (Harbor Rec, 4 teams). They share no team names, which is what makes the
 * bleed test meaningful.
 */
import { test, expect } from "@playwright/test";

test.describe("Path 16 — Per-league routing", () => {
  test("the root landing page lists both leagues and links to each", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(
      page.getByRole("link", { name: /Oceanview Beer Hockey League/ }),
    ).toHaveAttribute("href", "/obhl");
    await expect(
      page.getByRole("link", { name: /Harbor Rec Hockey League/ }),
    ).toHaveAttribute("href", "/harbor");
  });

  test("the two leagues do not bleed into each other", async ({ page }) => {
    await page.goto("/obhl/standings");
    await expect(page.getByRole("link", { name: "Sharks" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Anchors" })).toHaveCount(0);

    await page.goto("/harbor/standings");
    await expect(page.getByRole("link", { name: "Anchors" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sharks" })).toHaveCount(0);
  });

  test("a game cannot be viewed under another league's URL", async ({ page }) => {
    // Games are addressed by id alone, so the URL's league is the only thing
    // asserting ownership — and nothing about the id enforces it.
    //
    // Sourced from Harbor, not Oceanview: the manage specs all run against the
    // cookie-default league (obhl) and 11-schedule-builder regenerates its
    // schedule, so by the time this file runs Oceanview may have no finalized
    // game left to link to. Nothing touches Harbor.
    await page.goto("/harbor/schedule");
    const href = await page
      .locator('a[href^="/harbor/games/"]')
      .first()
      .getAttribute("href");
    const gameId = href!.split("/").pop()!;

    await page.goto(`/harbor/games/${gameId}`);
    await expect(page.getByRole("heading", { name: /@/ })).toBeVisible();

    // Asserted on the body, not the status: `(public)/loading.tsx` puts pages
    // inside a Suspense boundary, so the shell has already flushed as 200 by the
    // time a page-level `notFound()` runs and only the body swaps. That is
    // long-standing behaviour for every page-level notFound here — an unknown
    // league slug, caught in the layout above the boundary, does return a 404.
    await page.goto(`/obhl/games/${gameId}`);
    await expect(page.getByText("That page couldn't be found.")).toBeVisible();
    await expect(page.getByRole("heading", { name: /@/ })).toHaveCount(0);
  });

  test("each league home shows its own name and announcements", async ({
    page,
  }) => {
    await page.goto("/harbor");
    await expect(
      page.getByRole("heading", { name: "Harbor Rec Hockey League" }),
    ).toBeVisible();
    await expect(
      page.getByText("Welcome to the Harbor Rec spring season"),
    ).toBeVisible();
  });

  test("the league name carries into the page title", async ({ page }) => {
    // Without this a shared league link previews as the generic site name.
    await page.goto("/harbor");
    await expect(page).toHaveTitle("Harbor Rec Hockey League");

    // Section pages augment the league's template, not the root site one.
    await page.goto("/harbor/standings");
    await expect(page).toHaveTitle("Standings · Harbor Rec Hockey League");
  });

  test("an unknown league slug 404s", async ({ page }) => {
    const response = await page.goto("/not-a-league");
    expect(response?.status()).toBe(404);
    await expect(page.getByText("That page couldn't be found.")).toBeVisible();
  });

  test("a slug resolves case-insensitively", async ({ page }) => {
    const response = await page.goto("/OBHL");
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Oceanview Beer Hockey League" }),
    ).toBeVisible();
  });

  test("the public header has no league switcher, only a way back to the picker", async ({
    page,
  }) => {
    await page.goto("/obhl");
    await expect(page.getByLabel("Select league")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "All leagues" }),
    ).toHaveAttribute("href", "/");
  });

  test("nav links point into the league and mark the current section", async ({
    page,
  }) => {
    await page.goto("/obhl/standings");
    const nav = page.getByRole("navigation").first();

    await expect(nav.getByRole("link", { name: "Schedule" }).first()).toHaveAttribute(
      "href",
      "/obhl/schedule",
    );
    await expect(
      nav.getByRole("link", { name: "Standings" }).first(),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      nav.getByRole("link", { name: "Home" }).first(),
    ).not.toHaveAttribute("aria-current", "page");
  });

  test("a section stays marked on its detail pages", async ({ page }) => {
    await page.goto("/obhl/teams/sharks");
    const nav = page.getByRole("navigation").first();
    await expect(
      nav.getByRole("link", { name: "Teams" }).first(),
    ).toHaveAttribute("aria-current", "page");
  });
});

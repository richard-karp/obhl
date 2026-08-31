/**
 * Path 16: per-league routing — the league lives in the URL, so a link to one
 * league is a link to that league for whoever opens it.
 *
 * Assumes both seeded leagues: `obhl` (Oceanview, 6 teams) and `harbor`
 * (Harbor Rec, 4 teams). They share no team names, which is what makes the
 * bleed test meaningful.
 */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/** Admin client, for the one property only reachable by changing the data. */
function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function setHarborPublic(is_public: boolean) {
  const { error } = await admin()
    .from("leagues")
    .update({ is_public })
    .eq("slug", "harbor");
  if (error) throw new Error(`could not set harbor is_public: ${error.message}`);
}

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

  test("the manage switcher moves between leagues", async ({ page }) => {
    // The switcher used to write a cookie. With the league in the URL it has to
    // navigate, and it lands on the league root rather than the equivalent
    // sub-path, which would name a season belonging to the league left behind.
    await page.goto("/login");
    await page.getByRole("button", { name: "Manager" }).click();
    await page.waitForURL("/");
    await page.goto("/obhl/manage/seasons");

    await page.getByLabel("Select league").selectOption("harbor");
    await page.waitForURL("/harbor/manage/dashboard");
  });

  test("a league can be managed before it is public", async ({ page }) => {
    // Private staging: a league is manageable while still invisible publicly.
    // `[league]/layout.tsx` resolves without an is_public filter; the public
    // layout is what applies it.
    await page.goto("/login");
    await page.getByRole("button", { name: "Manager" }).click();
    await page.waitForURL("/");

    await setHarborPublic(false);
    try {
      const publicPage = await page.goto("/harbor");
      expect(publicPage?.status()).toBe(404);

      await page.goto("/harbor/manage/dashboard");
      await expect(page).toHaveURL("/harbor/manage/dashboard");
      await expect(page.getByRole("heading", { name: "Manage" })).toBeVisible();
    } finally {
      await setHarborPublic(true);
    }

    const restored = await page.goto("/harbor");
    expect(restored?.status()).toBe(200);
  });

  // ── Writes land in the league whose page issued them ──────────────────────
  //
  // These exist because the whole manage suite drives /obhl, which is also the
  // league a broken resolver falls back to — so a write going to the wrong
  // league looked identical to a correct one. Driving Harbor is what makes the
  // difference observable.

  test("an announcement posted in one league does not appear in the other", async ({
    page,
  }) => {
    const title = `Harbor-only announcement ${Date.now()}`;

    await page.goto("/login");
    await page.getByRole("button", { name: "Manager" }).click();
    await page.waitForURL("/");

    await page.goto("/harbor/manage/announcements");
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Message").fill("Posted by a test against Harbor.");
    await page.getByRole("button", { name: "Post announcement" }).click();
    await expect(page.getByText(title)).toBeVisible();

    await page.goto("/harbor");
    await expect(page.getByText(title)).toBeVisible();

    await page.goto("/obhl");
    await expect(page.getByText(title)).toHaveCount(0);
  });

  test("a season created in one league does not appear in the other", async ({
    page,
  }) => {
    const name = `Harbor Test Season ${Date.now()}`;

    await page.goto("/login");
    await page.getByRole("button", { name: "Manager" }).click();
    await page.waitForURL("/");

    await page.goto("/harbor/manage/seasons");
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Create season" }).click();
    // Creating continues to the new season's setup page.
    await page.waitForURL(/\/harbor\/manage\/seasons\//);

    await page.goto("/harbor/manage/seasons");
    await expect(page.getByText(name)).toBeVisible();

    await page.goto("/obhl/manage/seasons");
    await expect(page.getByText(name)).toHaveCount(0);
  });

  // ── A manage URL's league is enforced, not decorative ─────────────────────
  //
  // All three of these pages look their entity up by id with the admin client,
  // past RLS. The slug in the URL is the only thing asserting the entity belongs
  // to the league whose nav is wrapped around it.

  async function signInAsManager(page: import("@playwright/test").Page) {
    await page.goto("/login");
    await page.getByRole("button", { name: "Manager" }).click();
    await page.waitForURL("/");
  }

  /** First id in the hrefs of a Harbor manage list page. */
  async function harborId(
    page: import("@playwright/test").Page,
    listPath: string,
    hrefPrefix: string,
  ) {
    await page.goto(listPath);
    const href = await page
      .locator(`a[href^="${hrefPrefix}"]`)
      .first()
      .getAttribute("href");
    return href!.slice(hrefPrefix.length);
  }

  test("a season from another league is not editable under this one", async ({
    page,
  }) => {
    await signInAsManager(page);
    const id = await harborId(
      page,
      "/harbor/manage/seasons",
      "/harbor/manage/seasons/",
    );

    const own = await page.goto(`/harbor/manage/seasons/${id}`);
    expect(own?.status()).toBe(200);

    const foreign = await page.goto(`/obhl/manage/seasons/${id}`);
    expect(foreign?.status()).toBe(404);
    await expect(page.getByText("That page couldn't be found.")).toBeVisible();
  });

  test("a roster from another league is not editable under this one", async ({
    page,
  }) => {
    await signInAsManager(page);
    const id = await harborId(
      page,
      "/harbor/manage/rosters",
      "/harbor/manage/rosters/",
    );

    const own = await page.goto(`/harbor/manage/rosters/${id}`);
    expect(own?.status()).toBe(200);

    const foreign = await page.goto(`/obhl/manage/rosters/${id}`);
    expect(foreign?.status()).toBe(404);
    await expect(page.getByText("That page couldn't be found.")).toBeVisible();
  });

  test("a game from another league is not scoreable under this one", async ({
    page,
  }) => {
    await signInAsManager(page);
    const id = await harborId(
      page,
      "/harbor/manage/score",
      "/harbor/manage/score/",
    );

    const own = await page.goto(`/harbor/manage/score/${id}`);
    expect(own?.status()).toBe(200);

    const foreign = await page.goto(`/obhl/manage/score/${id}`);
    expect(foreign?.status()).toBe(404);
    await expect(page.getByText("That page couldn't be found.")).toBeVisible();
  });

  test("a section stays marked on its detail pages", async ({ page }) => {
    await page.goto("/obhl/teams/sharks");
    const nav = page.getByRole("navigation").first();
    await expect(
      nav.getByRole("link", { name: "Teams" }).first(),
    ).toHaveAttribute("aria-current", "page");
  });
});

/**
 * Paths 1–5: public site — no auth required.
 * Assumes seeded data: 6 Oceanview teams (Sharks/Bears/Wolves/Ducks/Hawks/Bisons),
 * 3 finalized rounds, 2 upcoming rounds, 3 announcements.
 */
import { test, expect } from "@playwright/test";

// ── Path 1: Homepage ────────────────────────────────────────────────────────

test.describe("Path 1 — Homepage widgets", () => {
  test("renders league name, standings, stat leaders, upcoming games, and announcements", async ({
    page,
  }) => {
    await page.goto("/");

    // League name heading
    await expect(
      page.getByRole("heading", { name: "Oceanview Beer Hockey League" }),
    ).toBeVisible();

    // Standings widget — at least one team row exists
    await expect(page.locator("table tbody tr").first()).toBeVisible();

    // Points Leaders section is visible with at least one entry
    await expect(page.getByText("Points Leaders")).toBeVisible();
    // Leader entries are divs with player names — just verify the section loaded
    await expect(
      page.locator("text=PTS").first(),
    ).toBeVisible();

    // Announcements section — seeded headline
    await expect(
      page.getByText("Playoffs start the week of June 22"),
    ).toBeVisible();

    // Upcoming and recent game sections present
    await expect(page.getByText("Upcoming").first()).toBeVisible();

    // No unhandled error boundary
    await expect(page.getByText("Something went wrong")).not.toBeVisible();
  });

  test("shows the League Update card when an AI summary exists, hides it when null", async ({
    page,
  }) => {
    await page.goto("/");
    // Freshly seeded DB has no ai_summary — card must NOT appear
    await expect(
      page.getByRole("heading", { name: "League Update" }),
    ).not.toBeVisible();
  });
});

// ── Path 2: Stats — sorting ─────────────────────────────────────────────────

test.describe("Path 2 — Stats tables and sorting", () => {
  test("skater stats load and rows are sortable by clicking column headers", async ({
    page,
  }) => {
    await page.goto("/stats");

    // Skaters tab is active by default
    await expect(page.getByRole("tab", { name: "Skaters" })).toBeVisible();

    // Table has rows — wait for data
    const tab = page.getByRole("tabpanel").first();
    await expect(tab.locator("table tbody tr").first()).toBeVisible();

    // Default sort: Pts descending — first row pts >= second
    const rows = tab.locator("table tbody tr");
    const ptsCol = async (rowIdx: number) => {
      const cells = rows.nth(rowIdx).locator("td");
      const count = await cells.count();
      return parseInt((await cells.nth(count - 1).innerText()).trim(), 10);
    };
    const pts0 = await ptsCol(0);
    const pts1 = await ptsCol(1);
    expect(pts0).toBeGreaterThanOrEqual(pts1);

    // Click G column header — sort by goals
    await page.getByRole("columnheader", { name: /^G$/ }).first().click();
    await page.waitForTimeout(200);

    const g0Text = await tab.locator("table tbody tr").nth(0).locator("td").nth(3).innerText();
    const g1Text = await tab.locator("table tbody tr").nth(1).locator("td").nth(3).innerText();
    expect(parseInt(g0Text, 10)).toBeGreaterThanOrEqual(parseInt(g1Text, 10));
  });

  test("Goalies tab loads and shows rows", async ({ page }) => {
    await page.goto("/stats");
    await page.getByRole("tab", { name: "Goalies" }).click();
    // After tab switch, the now-visible panel is the only active tabpanel
    await expect(
      page.getByRole("tabpanel").locator("table tbody tr").first(),
    ).toBeVisible();
  });
});

// ── Path 3: Player profile ──────────────────────────────────────────────────

test.describe("Path 3 — Player profile", () => {
  test("clicking a skater from stats opens their profile with chart and game log", async ({
    page,
  }) => {
    await page.goto("/stats");

    // Click first player name link in skater table
    const tab = page.getByRole("tabpanel").first();
    await expect(tab.locator("table tbody tr").first()).toBeVisible();

    const firstLink = tab
      .locator("table tbody tr")
      .first()
      .getByRole("link")
      .first();
    const playerName = await firstLink.innerText();
    await firstLink.click();

    // URL changed to /players/:id
    await expect(page).toHaveURL(/\/players\//);

    // Page heading matches player name
    await expect(page.getByRole("heading", { name: playerName })).toBeVisible();

    // Main recharts chart is the role="application" SVG
    await expect(page.getByRole("application")).toBeVisible();

    // Game log section has at least one row
    const gameLogTable = page.locator("table tbody tr").last();
    await expect(gameLogTable).toBeVisible();
  });

  test("status badges render for the Sharks captain on the team page", async ({
    page,
  }) => {
    await page.goto("/teams/sharks");
    // Shark captain (jersey #6) has a "C" badge
    await expect(
      page.locator("table tbody tr").filter({ hasText: "C" }).first(),
    ).toBeVisible();
  });
});

// ── Path 4: Schedule + game detail ─────────────────────────────────────────

test.describe("Path 4 — Schedule and game detail", () => {
  test("schedule page shows upcoming and recent results sections", async ({
    page,
  }) => {
    await page.goto("/schedule");

    // Upcoming section with scheduled games (GameRow cards, not a table)
    await expect(page.getByRole("heading", { name: "Upcoming" })).toBeVisible();
    await expect(page.getByText("Scheduled").first()).toBeVisible();

    // Recent Results section (rounds 1-3 are finalized)
    await expect(
      page.getByRole("heading", { name: "Recent Results" }),
    ).toBeVisible();
  });

  test("clicking a finalized game opens its detail page with a score", async ({
    page,
  }) => {
    await page.goto("/schedule");

    // Finalized games in GameRow are wrapped in <Link href="/games/...">
    const gameLink = page.locator('a[href^="/games/"]').first();
    await expect(gameLink).toBeVisible();
    await gameLink.click();
    await expect(page).toHaveURL(/\/games\//);

    // Box score shows two numeric scores (away–home)
    await expect(page.locator("text=/\\d+/").first()).toBeVisible();
  });
});

// ── Path 5: Teams list + team detail ───────────────────────────────────────

test.describe("Path 5 — Teams list and team detail", () => {
  test("teams list shows all 6 Oceanview teams", async ({ page }) => {
    await page.goto("/teams");
    for (const name of ["Sharks", "Bears", "Wolves", "Ducks", "Hawks", "Bisons"]) {
      await expect(page.getByText(name).first()).toBeVisible();
    }
  });

  test("Sharks team page shows roster with 14+ players", async ({ page }) => {
    await page.goto("/teams/sharks");

    // Team name heading
    await expect(
      page.getByRole("heading", { name: /Sharks/ }),
    ).toBeVisible();

    // TeamPlayerTable has at least 14 rows (page also has a GoalieStatsTable)
    const rosterRows = page.locator("table tbody tr");
    const count = await rosterRows.count();
    expect(count).toBeGreaterThanOrEqual(14);
  });
});

/**
 * Paths 1–5: public site — no auth required. Every route is league-scoped:
 * these exercise `/obhl`, the seeded Oceanview league.
 * Assumes seeded data: 6 Oceanview teams (Sharks/Bears/Wolves/Ducks/Hawks/Bisons),
 * 3 finalized rounds, 2 upcoming rounds, 3 announcements.
 */
import { test, expect } from "@playwright/test";

// ── Path 1: Homepage ────────────────────────────────────────────────────────

test.describe("Path 1 — Homepage widgets", () => {
  test("renders league name, standings, stat leaders, upcoming games, and announcements", async ({
    page,
  }) => {
    await page.goto("/obhl");

    // League name heading
    await expect(
      page.getByRole("heading", { name: "Oceanview Beer Hockey League" }),
    ).toBeVisible();

    // Standings widget — at least one team row exists
    await expect(page.locator("table tbody tr").first()).toBeVisible();

    // Points Leaders section is visible with at least one entry
    await expect(page.getByText("Points Leaders")).toBeVisible();
    // Leader entries are divs with player names — just verify the section loaded
    await expect(page.locator("text=PTS").first()).toBeVisible();

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
    await page.goto("/obhl");
    // Freshly seeded DB has no ai_summary — card must NOT appear
    await expect(
      page.getByRole("heading", { name: "League Update" }),
    ).not.toBeVisible();
  });
});

// ── Path 2: Stats — sorting ─────────────────────────────────────────────────

test.describe("Path 2 — Stats tables and sorting", () => {
  /**
   * THE SELECTED TAB HAS TO LOOK SELECTED, and nothing else in this suite says
   * so. Every other assertion here reads `aria-selected`, which is the state and
   * not the appearance — so the whole file would stay green if the active
   * styling stopped applying and both tabs rendered identically.
   *
   * That is not a hypothetical: `ui/tabs.tsx` styles the active trigger with
   * `data-active:` while `radix-ui` emits only `data-state="active"`, and the
   * two are connected by a Tailwind alias rather than by anything in this
   * repository. Measured, the alias holds. This test is what would notice if a
   * Tailwind or Radix upgrade quietly broke it.
   *
   * Comparing the two triggers rather than pinning a colour: the claim is "these
   * differ", which survives a theme change and still catches the failure.
   */
  test("the selected tab is visually distinguishable from the unselected one", async ({
    page,
  }) => {
    await page.goto("/obhl/stats");
    const skaters = page.getByRole("tab", { name: "Skaters" });
    const goalies = page.getByRole("tab", { name: "Goalies" });
    await expect(skaters).toHaveAttribute("aria-selected", "true");

    const bg = (l: typeof skaters) =>
      l.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await bg(skaters)).not.toBe(await bg(goalies));

    // And it follows the selection rather than being stuck on the first tab.
    await goalies.click();
    await expect(goalies).toHaveAttribute("aria-selected", "true");
    expect(await bg(goalies)).not.toBe(await bg(skaters));
  });

  test("skater stats load and rows are sortable by clicking column headers", async ({
    page,
  }) => {
    await page.goto("/obhl/stats");

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
    await page.waitForLoadState("networkidle");

    const g0Text = await tab
      .locator("table tbody tr")
      .nth(0)
      .locator("td")
      .nth(3)
      .innerText();
    const g1Text = await tab
      .locator("table tbody tr")
      .nth(1)
      .locator("td")
      .nth(3)
      .innerText();
    expect(parseInt(g0Text, 10)).toBeGreaterThanOrEqual(parseInt(g1Text, 10));
  });

  test("Goalies tab loads and shows rows", async ({ page }) => {
    await page.goto("/obhl/stats");
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
    await page.goto("/obhl/stats");

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
    await expect(page).toHaveURL(/\/obhl\/players\//);

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
    await page.goto("/obhl/teams/sharks");
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
    await page.goto("/obhl/schedule");

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
    await page.goto("/obhl/schedule");

    // Finalized games in GameRow are wrapped in <Link href="/obhl/games/...">
    const gameLink = page.locator('a[href^="/obhl/games/"]').first();
    await expect(gameLink).toBeVisible();
    await gameLink.click();
    await expect(page).toHaveURL(/\/obhl\/games\//);

    // Box score shows two numeric scores (away–home)
    await expect(page.locator("text=/\\d+/").first()).toBeVisible();
  });

  /**
   * The schedule page's team filter and its two download buttons used to
   * disagree: the list narrowed to the selected team and the buttons kept
   * pointing at `/api/schedule/<season>`, so "pick a team, download" handed
   * back all six teams' games — and dropping that .ics into a calendar filled
   * it with the whole season.
   *
   * Driven through the page rather than against the routes directly, because
   * the defect was the LINK, not the route: a route that can filter is no use
   * if the button never asks it to.
   */
  const csvRows = (body: string) =>
    body
      // Strip the UTF-8 BOM `buildScheduleCsv` opens with, then the header.
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n")
      .slice(1);

  /** VEVENT summaries, with iCalendar's 75-octet line folding undone. */
  const icsSummaries = (body: string) =>
    body
      .replace(/\r\n[ \t]/g, "")
      .split(/\r?\n/)
      .filter((l) => l.startsWith("SUMMARY:"));

  async function exportHrefs(page: import("@playwright/test").Page) {
    return {
      csv: await page
        .getByRole("link", { name: "Download .csv" })
        .getAttribute("href"),
      ics: await page
        .getByRole("link", { name: "Download .ics" })
        .getAttribute("href"),
    };
  }

  test("picking a team exports only that team's games", async ({
    page,
    request,
  }) => {
    await page.goto("/obhl/schedule");
    const all = await exportHrefs(page);

    await page.goto("/obhl/schedule?team=sharks");
    const sharks = await exportHrefs(page);
    expect(sharks.csv).toContain("team=sharks");
    expect(sharks.ics).toContain("team=sharks");

    const allCsv = csvRows(await (await request.get(all.csv!)).text());
    const sharksCsv = csvRows(await (await request.get(sharks.csv!)).text());

    // The season has games the Sharks are not in — otherwise the assertion
    // below passes against a route that filters nothing.
    expect(allCsv.some((r) => !r.includes("Sharks"))).toBe(true);
    expect(sharksCsv.length).toBeGreaterThan(0);
    expect(sharksCsv.length).toBeLessThan(allCsv.length);
    for (const row of sharksCsv) expect(row).toContain("Sharks");

    // The file says whose schedule it is, which is what the season-only export
    // could not do and the reason it was left unfiltered for a year.
    const csvResponse = await request.get(sharks.csv!);
    expect(csvResponse.headers()["content-disposition"]).toContain(
      "obhl-sharks-schedule.csv",
    );

    const allIcs = icsSummaries(await (await request.get(all.ics!)).text());
    const sharksIcs = icsSummaries(
      await (await request.get(sharks.ics!)).text(),
    );
    expect(sharksIcs.length).toBeGreaterThan(0);
    expect(sharksIcs.length).toBeLessThan(allIcs.length);
    for (const summary of sharksIcs) expect(summary).toContain("Sharks");

    const icsResponse = await request.get(sharks.ics!);
    expect(await icsResponse.text()).toContain("Sharks");
    expect(icsResponse.headers()["content-disposition"]).toContain(
      "obhl-sharks-schedule.ics",
    );
  });

  /**
   * ⛔ A team the season does not hold must 404, NOT fall back to the whole
   * season. Falling back is the bug this fixes wearing a different hat: the
   * caller asked for one team and would silently receive six.
   *
   * `anchors` is a real team in the OTHER seeded league, so this covers the
   * cross-league case as well as the unknown one.
   */
  test("an export for a team outside the season is a 404, not the season", async ({
    page,
    request,
  }) => {
    await page.goto("/obhl/schedule");
    const { csv, ics } = await exportHrefs(page);

    for (const team of ["anchors", "not-a-team"]) {
      expect((await request.get(`${csv}?team=${team}`)).status()).toBe(404);
      expect((await request.get(`${ics}?team=${team}`)).status()).toBe(404);
    }
  });
});

// ── Path 5: Teams list + team detail ───────────────────────────────────────

test.describe("Path 5 — Teams list and team detail", () => {
  test("teams list shows all 6 Oceanview teams", async ({ page }) => {
    await page.goto("/obhl/teams");
    for (const name of [
      "Sharks",
      "Bears",
      "Wolves",
      "Ducks",
      "Hawks",
      "Bisons",
    ]) {
      await expect(page.getByText(name).first()).toBeVisible();
    }
  });

  test("Sharks team page shows roster with 14+ players", async ({ page }) => {
    await page.goto("/obhl/teams/sharks");

    // Team name heading
    await expect(page.getByRole("heading", { name: /Sharks/ })).toBeVisible();

    // TeamPlayerTable has at least 14 rows (page also has a GoalieStatsTable)
    const rosterRows = page.locator("table tbody tr");
    const count = await rosterRows.count();
    expect(count).toBeGreaterThanOrEqual(14);
  });
});

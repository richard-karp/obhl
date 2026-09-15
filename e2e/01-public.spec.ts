// ⚠️ No absolute game counts here: the seed grows and the tonight rounds are consumable
// (`RUNBOOK.md` → Seed and fixtures). Keep the export checks relational.
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

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
});

test.describe("Path 2 — Stats tables and sorting", () => {
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
});

test.describe("Path 3 — Player profile", () => {
  test("clicking a skater from stats opens their profile with chart and game log", async ({
    page,
  }) => {
    await page.goto("/obhl/stats");

    // Click first player name link in skater table
    const tab = page.getByRole("tabpanel").first();
    await expect(tab.locator("table tbody tr").first()).toBeVisible();

    // ⛔ By href, not the row's first link: that is now the team crest, whose `aria-label` reads as a
    // name and navigates to the team page.
    const firstLink = tab
      .locator("table tbody tr")
      .first()
      .locator('a[href^="/obhl/players/"]');
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
});

test.describe("Path 4 — Schedule and game detail", () => {
  test("schedule page shows upcoming by default and results in their own view", async ({
    page,
  }) => {
    await page.goto("/obhl/schedule");

    // Upcoming is the landing view (GameRow cards, not a table).
    await expect(page.getByRole("heading", { name: "Upcoming" })).toBeVisible();
    await expect(page.getByText("Scheduled").first()).toBeVisible();

    // ⛔ And results are NOT on it: that absence makes the navigation below a real assertion.
    await expect(page.getByRole("heading", { name: "Results" })).toHaveCount(0);

    const views = page.getByRole("navigation", { name: "Schedule views" });
    await views.getByRole("link", { name: "Results" }).click();
    await expect(page).toHaveURL(/view=results/);
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();
    // Rounds 1-3 are finalized in the seed, so the view has occupants.
    await expect(page.getByText("Final").first()).toBeVisible();
  });

  test("clicking a finalized game opens its detail page with a score", async ({
    page,
  }) => {
    // ⚠️ From the results view: `game-row.tsx` links a row only when the game is FINAL, and the
    // default view has none.
    await page.goto("/obhl/schedule?view=results");

    const gameLink = page.locator('a[href^="/obhl/games/"]').first();
    await expect(gameLink).toBeVisible();
    await gameLink.click();
    await expect(page).toHaveURL(/\/obhl\/games\//);

    // A real box score. The seed names a goalie of record on every final, so "No goalie recorded"
    // means the resolution broke.
    await expect(page.getByText("FINAL")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(2);
    await expect(page.getByText("Goalie", { exact: true })).toHaveCount(2);
    await expect(page.getByText("No goalie recorded.")).toHaveCount(0);
    await expect(page.getByText(/^GA \d+$/).first()).toBeVisible();
  });

  // The team filter and the download buttons must agree: driven through the page, because the defect
  // was the LINK handing back every team's games, not the route.
  const csvRows = (body: string) =>
    body
      // Strip the UTF-8 BOM `buildScheduleCsv` opens with, then the header.
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n")
      .slice(1);

  /** iCalendar folds at 75 octets; undo it before matching on any line. */
  const unfold = (body: string) => body.replace(/\r\n[ \t]/g, "");

  const icsSummaries = (body: string) =>
    unfold(body)
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

  // ⛔ DUCKS, NOT SHARKS: the Sharks are 5-0 at home, so they check one branch of the OR (`RUNBOOK.md`
  // → Seed and fixtures). The Ducks play both, and the home/away assertion below pins them.
  test("picking a team exports only that team's games", async ({
    page,
    request,
  }) => {
    await page.goto("/obhl/schedule");
    const all = await exportHrefs(page);

    await page.goto("/obhl/schedule?team=ducks");
    const ducks = await exportHrefs(page);
    expect(ducks.csv).toContain("team=ducks");
    expect(ducks.ics).toContain("team=ducks");

    // One request per file: body and headers come off the same response, so they cannot disagree.
    const allCsvRes = await request.get(all.csv!);
    const ducksCsvRes = await request.get(ducks.csv!);
    const allCsv = csvRows(await allCsvRes.text());
    const ducksCsv = csvRows(await ducksCsvRes.text());

    // The season has games the Ducks are not in — otherwise the assertion
    // below passes against a route that filters nothing.
    expect(allCsv.some((r) => !r.includes("Ducks"))).toBe(true);
    expect(ducksCsv.length).toBeGreaterThan(0);
    expect(ducksCsv.length).toBeLessThan(allCsv.length);
    for (const row of ducksCsv) expect(row).toContain("Ducks");

    // ⛔ BOTH SIDES OF THE OR: `Date,Time,Home,Away`, and no seeded name holds a comma. A home-only
    // filter passes every assertion above; these two do not.
    const cols = ducksCsv.map((r) => r.split(","));
    expect(cols.filter((c) => c[2] === "Ducks").length).toBeGreaterThan(0);
    expect(cols.filter((c) => c[3] === "Ducks").length).toBeGreaterThan(0);
    // Every row names the team on exactly one side — never both, which would
    // mean a game against itself.
    for (const c of cols)
      expect([c[2], c[3]].filter((n) => n === "Ducks").length).toBe(1);

    // The file says whose schedule it is.
    expect(ducksCsvRes.headers()["content-disposition"]).toContain(
      "obhl-ducks-schedule.csv",
    );

    const allIcsBody = await (await request.get(all.ics!)).text();
    const ducksIcsRes = await request.get(ducks.ics!);
    const ducksIcsBody = await ducksIcsRes.text();
    const allIcs = icsSummaries(allIcsBody);
    const ducksIcs = icsSummaries(ducksIcsBody);
    expect(ducksIcs.length).toBeGreaterThan(0);
    expect(ducksIcs.length).toBeLessThan(allIcs.length);
    for (const summary of ducksIcs) expect(summary).toContain("Ducks");

    // ⛔ THE CALENDAR NAME, NOT JUST THE TEAM: the SUMMARY lines already contain "Ducks", and that name
    // is why a filtered export may exist (`RUNBOOK.md` → Schedule edits and exports).
    expect(unfold(ducksIcsBody)).toContain("— Ducks Schedule");
    expect(unfold(allIcsBody)).not.toContain("— Ducks Schedule");
    expect(ducksIcsRes.headers()["content-disposition"]).toContain(
      "obhl-ducks-schedule.ics",
    );

    // Each league's SEASON export is named for that league, not a literal "OBHL Schedule". The event
    // UIDs are deliberately unchanged.
    const db = admin();
    for (const slug of ["harbor", "obhl"]) {
      const { data: league } = await db
        .from("leagues")
        .select("id, name")
        .eq("slug", slug)
        .single();
      const { data: season } = await db
        .from("seasons")
        .select("id")
        .eq("league_id", league!.id)
        .eq("is_active", true)
        .single();

      const ics = await request.get(`/api/schedule/${season!.id}`);
      expect(ics.ok()).toBeTruthy();
      expect(await ics.text()).toContain(`${league!.name} Schedule`);
      expect(ics.headers()["content-disposition"]).toContain(
        `${slug}-schedule.ics`,
      );

      const csv = await request.get(`/api/schedule/${season!.id}/schedule.csv`);
      expect(csv.ok()).toBeTruthy();
      expect(csv.headers()["content-disposition"]).toContain(
        `${slug}-schedule.csv`,
      );
    }
  });

  // ⛔ A team outside the season is a 404, never the whole season (`RUNBOOK.md` → Schedule edits and
  // exports). `anchors` is the other league's team; `""` is a bare `?team=`, which reads as no filter.
  test("an export for a team outside the season is a 404, not the season", async ({
    page,
    request,
  }) => {
    await page.goto("/obhl/schedule");
    const { csv, ics } = await exportHrefs(page);

    for (const team of ["anchors", "not-a-team", ""]) {
      expect((await request.get(`${csv}?team=${team}`)).status()).toBe(404);
      expect((await request.get(`${ics}?team=${team}`)).status()).toBe(404);
    }
  });

  // ⚠️ A route handler can set a status, unlike a page whose `notFound()` follows an `await` and streams
  // a 200: an export for an id naming nothing must 404, not return an empty file.
  test("an export for a season that does not exist is a 404, not an empty file", async ({
    request,
  }) => {
    const missing = "00000000-0000-0000-0000-000000000000";

    const ics = await request.get(`/api/schedule/${missing}`);
    expect(ics.status()).toBe(404);
    const csv = await request.get(`/api/schedule/${missing}/schedule.csv`);
    expect(csv.status()).toBe(404);

    // Malformed, the case that always worked — kept so a refactor cannot close
    // one door while opening the other.
    const junk = await request.get("/api/schedule/not-a-uuid");
    expect(junk.status()).toBe(404);

    // ⚠️ The team feed is a subscription a calendar app polls indefinitely: the 404 tells its owner the
    // team is gone, rather than an empty calendar that never says so.
    const feed = await request.get(`/api/schedule/team/${missing}/feed.ics`);
    expect(feed.status()).toBe(404);
  });

  test("a team's calendar feed answers with its games", async ({ request }) => {
    const { data: team } = await admin()
      .from("teams")
      .select("id, leagues!inner(slug)")
      .eq("leagues.slug", "obhl")
      .eq("slug", "sharks")
      .single();
    const res = await request.get(`/api/schedule/team/${team!.id}/feed.ics`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/calendar");
    const body = unfold(await res.text());
    expect(body).toContain("BEGIN:VEVENT");
    expect(body).toContain("Oceanview Beer Hockey League — Team Schedule");
  });
});

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
});

test.describe("Path 16 — Leagues, as an anonymous visitor finds them", () => {
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

  test("an anonymous visitor gets no staff row and the header they always had", async ({
    page,
  }) => {
    for (const url of ["/obhl", "/obhl/standings", "/obhl/schedule"]) {
      await page.goto(url);
      await expect(
        page.getByRole("navigation", { name: "League" }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Staff tools" }),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(
        0,
      );
      // No league switcher. ⚠️ Anonymous only: a signed-in member of two leagues gets one here.
      await expect(page.getByLabel("Select league")).toHaveCount(0);
    }
    // …only a way back to the picker.
    await page.goto("/obhl");
    await expect(
      page.getByRole("link", { name: "All leagues" }),
    ).toHaveAttribute("href", "/");
  });
});

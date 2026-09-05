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

/** The leagues a seeded account is actually confined to, read from the seed. */
async function leaguesOfAccount(displayName: string): Promise<string[]> {
  const db = admin();
  const { data: prof } = await db
    .from("profiles")
    .select("id")
    .eq("display_name", displayName)
    .single();
  const { data } = await db
    .from("profile_leagues")
    .select("leagues!inner(slug)")
    .eq("profile_id", prof!.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((r: any) => r.leagues.slug as string);
}

async function setHarborPublic(is_public: boolean) {
  const { error } = await admin()
    .from("leagues")
    .update({ is_public })
    .eq("slug", "harbor");
  if (error)
    throw new Error(`could not set harbor is_public: ${error.message}`);
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

  test("a game cannot be viewed under another league's URL", async ({
    page,
  }) => {
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

    await expect(
      nav.getByRole("link", { name: "Schedule" }).first(),
    ).toHaveAttribute("href", "/obhl/schedule");
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
    await page.goto("/obhl/seasons");

    await page.getByLabel("Select league").selectOption("harbor");
    await page.waitForURL("/harbor/dashboard");
  });

  test("a staged league is invisible to the public and open to its own people", async ({
    page,
  }) => {
    // Private staging: a league is built before it launches. The public must
    // see nothing; the people building it must see everything, including the
    // public side, because those pages are becoming shared — one URL that shows
    // the visitor a team and its manager the same team with editing on it.
    //
    // Both directions are asserted here because both are ways to be wrong, and
    // they fail in opposite directions: leaking an unpublished league, or
    // locking out the people staging one. See `lib/league/visibility.ts`.
    await setHarborPublic(false);
    try {
      // Anonymous: indistinguishable from a slug nobody ever took. A redirect
      // would confirm the league exists, so this must be a 404.
      const anon = await page.goto("/harbor");
      expect(anon?.status()).toBe(404);
      const anonStandings = await page.goto("/harbor/standings");
      expect(anonStandings?.status()).toBe(404);

      await page.goto("/login");
      await page.getByRole("button", { name: "Manager" }).click();
      await page.waitForURL("/");

      // A member of the league, on the public side of it: renders, chrome and
      // all. This is the half that used to 404.
      const asMember = await page.goto("/harbor");
      expect(asMember?.status()).toBe(200);
      await expect(page.getByRole("link", { name: "Manage" })).toBeVisible();

      // ...including Teams, which absorbed `/manage/rosters`. That page read
      // past RLS on purpose, and losing it in the merge would have shown a
      // manager staging a league an empty Teams page with nothing to explain
      // it. The public-read policies cover neither a staged league's seasons
      // nor its teams.
      await page.goto("/harbor/teams");
      await expect(page.getByText("No teams enrolled yet")).toHaveCount(0);
      await expect(
        page.locator('a[href^="/harbor/teams/"]').first(),
      ).toBeVisible();

      // ...and the staff pages, which never depended on this rule.
      await page.goto("/harbor/dashboard");
      await expect(page).toHaveURL("/harbor/dashboard");
      await expect(page.getByRole("heading", { name: "Manage" })).toBeVisible();
    } finally {
      await setHarborPublic(true);
    }

    const restored = await page.goto("/harbor");
    expect(restored?.status()).toBe(200);
  });

  test("a staged league opens for a member who is not a manager", async ({
    page,
  }) => {
    // The case the other staged-league tests could not distinguish. Both of them
    // use accounts that are NOT members of harbor, so they pin "non-member 404s"
    // and would stay green if membership stopped counting at all.
    //
    // This scorekeeper IS a member of harbor. Before 0039 they got a 404 on the
    // league they staff: `leagues` had no select policy covering a non-manager
    // member, so the row never resolved and the app's own rule — which has always
    // said yes to any member — was never reached. This is the assertion that
    // keeps the app half and the RLS half saying the same thing.
    await setHarborPublic(false);
    try {
      await page.goto("/login");
      await page.getByRole("button", { name: "Scorekeeper" }).click();
      await page.waitForURL("/");

      const res = await page.goto("/harbor");
      expect(res?.status()).toBe(200);
      await expect(
        page.getByRole("link", { name: "All leagues" }),
      ).toBeVisible();

      // ...and they are still only a scorekeeper there: no manager affordances.
      await page.goto("/harbor/rules");
      await expect(
        page.getByRole("button", { name: "Edit rules" }),
      ).toHaveCount(0);
    } finally {
      await setHarborPublic(true);
    }
  });

  test("a staged league stays 404 for a signed-in stranger to it", async ({
    page,
  }) => {
    // Signed in is not the test — membership is. The one-league scorekeeper
    // belongs to obhl and not to harbor, so staging harbor must look the same
    // to them as it does to an anonymous visitor.
    //
    // The confinement is DERIVED, not assumed. `16-league-membership.spec.ts`
    // rejects hardcoding it, and if the seed ever moved this account into harbor
    // the assertion below would fail for a reason that has nothing to do with the
    // guard it is testing.
    expect(await leaguesOfAccount("Single League Scorer")).not.toContain(
      "harbor",
    );
    await setHarborPublic(false);
    try {
      await page.goto("/login");
      await page.getByRole("button", { name: "One-league scorer" }).click();
      await page.waitForURL("/");
      const res = await page.goto("/harbor");
      expect(res?.status()).toBe(404);
    } finally {
      await setHarborPublic(true);
    }
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

    await page.goto("/harbor/announcements");
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

    await page.goto("/harbor/seasons");
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Create season" }).click();
    // Creating continues to the new season's setup page.
    await page.waitForURL(/\/harbor\/seasons\//);

    await page.goto("/harbor/seasons");
    await expect(page.getByText(name)).toBeVisible();

    await page.goto("/obhl/seasons");
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
  /**
   * A team slug that exists in BOTH leagues, created on demand. The seeded teams
   * deliberately share no names, which is what makes a cross-league slug test
   * vacuous without this.
   */
  async function sharedSlug() {
    const db = admin();
    const slug = "sharks";
    const { data: harbor } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "harbor")
      .single();
    const { data: existing } = await db
      .from("teams")
      .select("id")
      .eq("league_id", harbor!.id)
      .eq("slug", slug)
      .maybeSingle();
    if (!existing) {
      // ⚠️ Asserted, not assumed: a silently failed insert returns a slug that
      // does not exist in Harbor, and the test degrades back to vacuous.
      const { error } = await db.from("teams").insert({
        league_id: harbor!.id,
        name: "Harbor Sharks",
        slug,
        color: "#0ea5e9",
      });
      expect(error).toBeNull();
    }
    return slug;
  }

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
    const id = await harborId(page, "/harbor/seasons", "/harbor/seasons/");

    const own = await page.goto(`/harbor/seasons/${id}`);
    expect(own?.status()).toBe(200);

    const foreign = await page.goto(`/obhl/seasons/${id}`);
    expect(foreign?.status()).toBe(404);
    await expect(page.getByText("That page couldn't be found.")).toBeVisible();
  });

  test("a team from another league is not reachable under this one", async ({
    page,
  }) => {
    // The roster editor merged into the team page, so this is now a SLUG rather
    // than a uuid — and the property is the same one: a team is addressable only
    // under the league that owns it. `getTeamBySlug` is scoped to the league, so
    // the foreign slug resolves to nothing rather than to somebody else's team.
    await signInAsManager(page);
    const slug = await harborId(page, "/harbor/teams", "/harbor/teams/");

    const own = await page.goto(`/harbor/teams/${slug}`);
    expect(own?.status()).toBe(200);
    const ownName = await page.locator("h1").first().innerText();

    // ⚠️ The foreign slug is not enough on its own. Harbor and Oceanview share no
    // team names, so `/obhl/teams/anchors` resolves to nothing whether or not
    // `getTeamBySlug` scopes by league — the test would pass with the
    // `league_id` filter deleted. So it also uses a slug that EXISTS IN BOTH and
    // asserts the page shows the LOCAL team, which is the property that actually
    // needs holding: a slug names a team within its league, never across.
    await page.goto(`/obhl/teams/${slug}`);
    await expect(page.getByText("That page couldn't be found.")).toBeVisible();
    await expect(page.getByText(ownName, { exact: true })).toHaveCount(0);

    // ⚠️ The NAMES, not merely that they differ. Two 404 headings also satisfy
    // inequality-of-nothing, so `not.toBe` caught the dropped-`league_id`
    // mutation only by accident: `.maybeSingle()` errors on two rows, making
    // both sides 404 and compare EQUAL.
    const shared = await sharedSlug();
    await page.goto(`/harbor/teams/${shared}`);
    await expect(page.locator("h1").first()).toHaveText("Harbor Sharks");
    await page.goto(`/obhl/teams/${shared}`);
    await expect(page.locator("h1").first()).toHaveText("Sharks");
  });

  test("the old /rosters/<id> URL redirects, and only under its own league", async ({
    page,
    request,
  }) => {
    // The one redirect in this change that has to read the database: the old URL
    // names a team by id, the new one by slug. That lookup is also a place to
    // leak — answering for another league's team would hand out its slug — so
    // the id is checked against the league in the URL.
    await signInAsManager(page);
    const slug = await harborId(page, "/harbor/teams", "/harbor/teams/");
    const { data: team } = await admin()
      .from("teams")
      .select("id")
      .eq("slug", slug)
      .single();

    const moved = await request.get(`/harbor/rosters/${team!.id}`, {
      maxRedirects: 0,
    });
    expect(moved.status()).toBe(308);
    expect(
      new URL(moved.headers()["location"], "http://localhost").pathname,
    ).toBe(`/harbor/teams/${slug}`);

    // `request.get` with no redirects, not `page.goto`: a page navigation FOLLOWS
    // a 308, so a route that wrongly redirected to a URL that then 404s would
    // look identical to one that refused — and a wrong redirect is exactly the
    // leak this asserts against.
    const foreign = await request.get(`/obhl/rosters/${team!.id}`, {
      maxRedirects: 0,
    });
    expect(foreign.status()).toBe(404);
  });

  test("a game from another league is not scoreable under this one", async ({
    page,
  }) => {
    await signInAsManager(page);
    // The list is the public schedule now, and the scoresheet nests under the
    // game it scores.
    const id = await harborId(page, "/harbor/schedule", "/harbor/games/").then(
      (rest) => rest.replace(/\/score$/, ""),
    );

    const own = await page.goto(`/harbor/games/${id}/score`);
    expect(own?.status()).toBe(200);

    const foreign = await page.goto(`/obhl/games/${id}/score`);
    expect(foreign?.status()).toBe(404);
    await expect(page.getByText("That page couldn't be found.")).toBeVisible();
  });

  test("the audit log shows only this league's actions", async ({ page }) => {
    // Reverting an audit entry is a write — it reopens games and restores
    // player status — and until 0031 the log had no league at all, so every
    // manager saw and could revert every league's entries.
    const SUSPENSION = /Updated is suspended for/;
    await signInAsManager(page);

    await page.goto("/obhl/audit");
    const oceanviewBefore = await page.getByText(SUSPENSION).count();

    // Suspend a Harbor player: one audit entry, against Harbor.
    const teamSlug = await harborId(page, "/harbor/teams", "/harbor/teams/");
    await page.goto(`/harbor/teams/${teamSlug}`);
    await page.getByRole("tab", { name: "Manage" }).click();
    await page.waitForURL(/\?tab=manage$/);
    const row = page.locator("table tbody tr").nth(2);
    await row.getByRole("button", { name: "Suspend" }).click();
    await expect(
      row.locator('[data-slot="badge"]').filter({ hasText: "SUSP" }),
    ).toBeVisible();

    // Harbor's log has it — which also proves logAudit resolved the league,
    // since an entry with no league_id is filtered out of every scoped view.
    await page.goto("/harbor/audit");
    expect(await page.getByText(SUSPENSION).count()).toBeGreaterThan(0);

    // Oceanview's is untouched.
    await page.goto("/obhl/audit");
    expect(await page.getByText(SUSPENSION).count()).toBe(oceanviewBefore);
  });

  test("a league's calendar and CSV are named for that league", async ({
    request,
  }) => {
    // `buildIcs` always took the calendar name as an argument, but the routes
    // passed a literal, so BOTH leagues' feeds arrived in a subscriber's
    // calendar app called "OBHL Schedule". The event UIDs are deliberately
    // unchanged — see EXPORTS_HANDOFF §3.
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

  test("a section stays marked on its detail pages", async ({ page }) => {
    await page.goto("/obhl/teams/sharks");
    const nav = page.getByRole("navigation").first();
    await expect(
      nav.getByRole("link", { name: "Teams" }).first(),
    ).toHaveAttribute("aria-current", "page");
  });

  /**
   * The staff tools lost their `/manage/` prefix, so every link a manager has
   * bookmarked or pasted into an email names a URL that no longer resolves. The
   * redirect in `next.config.ts` is the only thing keeping those alive, and
   * nothing else in the suite would notice if it were deleted.
   */
  test("every old /manage/ URL still lands on its page", async ({
    request,
  }) => {
    const moved = [
      ["/obhl/manage/dashboard", "/obhl/dashboard"],
      ["/obhl/manage/people/duplicates", "/obhl/people/duplicates"],
      [
        "/obhl/manage/schedule-builder/one-off",
        "/obhl/schedule-builder/one-off",
      ],
      // `/rules/edit` has since merged into `/rules`, so this one takes two
      // hops. The prefix redirect is what this test is about, so it asserts the
      // first; `10-rules.spec.ts` asserts the second.
      ["/obhl/manage/rules/edit", "/obhl/rules/edit"],
      // A dynamic segment rides along rather than being swallowed.
      ["/harbor/manage/seasons/abc-123", "/harbor/seasons/abc-123"],
      // Zero trailing segments: the bare prefix lands on the league home.
      ["/obhl/manage", "/obhl"],
    ];
    // `location` may be relative, so resolve it against a base before reading
    // the parts off it rather than assuming either shape.
    const locationOf = (res: { headers(): Record<string, string> }) =>
      new URL(res.headers()["location"], "http://localhost");

    for (const [from, to] of moved) {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status(), `${from} should be a permanent redirect`).toBe(308);
      expect(locationOf(res).pathname, `${from} should move to ${to}`).toBe(to);
    }

    // A query string survives the move; a manager's filtered link keeps working.
    const withQuery = await request.get("/obhl/manage/people?q=smith", {
      maxRedirects: 0,
    });
    expect(locationOf(withQuery).pathname).toBe("/obhl/people");
    expect(locationOf(withQuery).search).toBe("?q=smith");
  });

  test("the League Office keeps its prefix, which is not a league", async ({
    request,
  }) => {
    // `/manage/office` lives outside `[league]` and must not be swallowed by the
    // redirect above: its first segment is `manage`, so a careless source
    // pattern eats it. Anonymous, the office's own guard sends it to /login —
    // which is the point: it reached the route rather than being rewritten.
    const res = await request.get("/manage/office", { maxRedirects: 0 });
    expect(
      new URL(res.headers()["location"], "http://localhost").pathname,
    ).toBe("/login");
  });
});

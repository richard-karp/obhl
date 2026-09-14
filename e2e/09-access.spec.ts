/** Who may reach what: page guards, league scoping, and the refusals the database makes itself. */
/**
 * Path 15: Role-based access — scorekeepers and captains blocked from manager-only routes.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

type Role =
  | "Manager"
  | "Scorekeeper"
  | "Captain"
  | "One-league mgr"
  | "One-league scorer"
  | "No-league mgr"
  | "Commissioner"
  | "Deputy";

/** Dev-panel sign-in. A scorekeeper lands on `/tonight`, everyone else on the picker. */
async function signInAs(page: Page, role: Role, then?: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: role, exact: true }).click();
  await page.waitForURL(
    role === "Scorekeeper" || role === "One-league scorer" ? "/tonight" : "/",
  );
  if (then) await page.goto(then);
}

test.describe("Path 15 — Role-based access control", () => {
  test("scorekeeper cannot reach /seasons", async ({ page }) => {
    await signInAs(page, "Scorekeeper", "/obhl/dashboard");
    await page.goto("/obhl/seasons");
    await expect(page).toHaveURL("/");
  });

  test("scorekeeper cannot reach /audit", async ({ page }) => {
    await signInAs(page, "Scorekeeper", "/obhl/dashboard");
    await page.goto("/obhl/audit");
    await expect(page).toHaveURL("/");
  });

  test("scorekeeper cannot reach /people", async ({ page }) => {
    await signInAs(page, "Scorekeeper", "/obhl/dashboard");
    await page.goto("/obhl/people");
    await expect(page).toHaveURL("/");
  });

  test("unauthenticated user cannot reach /dashboard", async ({ page }) => {
    await page.goto("/obhl/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});

/**
 * Path 16: per-league routing — the league lives in the URL, so a link to one
 * league is a link to that league for whoever opens it.
 *
 * Assumes both seeded leagues: `obhl` (Oceanview, 6 teams) and `harbor`
 * (Harbor Rec, 4 teams). They share no team names, which is what makes the
 * bleed test meaningful.
 */
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
    //
    // ⚠️ THE RESULTS VIEW, because only a FINAL game's row is wrapped in a
    // `/harbor/games/<id>` link (`game-row.tsx`) and the schedule's default
    // view is Upcoming. Harbor's four finals are all in the past, so the bare
    // URL now offers nothing to click — it used to work only because every
    // section was stacked on one page.
    await page.goto("/harbor/schedule?view=results");
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

      await signInAs(page, "Manager");

      // A member of the league, on the public side of it: renders, chrome and
      // all. This is the half that used to 404.
      const asMember = await page.goto("/harbor");
      expect(asMember?.status()).toBe(200);
      // The staff row, which is what a member's chrome is now — there is no
      // "Manage" cross-link because there is nothing to cross to.
      await expect(
        page.getByRole("navigation", { name: "Staff tools" }),
      ).toBeVisible();

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

      // ⛔ AND THE PICKER LISTS IT, BADGED. This is the half that has no other
      // route: `getPublicLeagues` filters `is_public`, so before the picker
      // learned about membership a staged league appeared NOWHERE on `/` — and
      // for a single-league manager the "Manage" cross-link this change removed
      // pointed at exactly that league, with `LeagueSwitcher` rendering null
      // below two leagues. Typing the URL was all that was left.
      //
      // The badge is asserted, not just the link: a manager who cannot tell
      // which of their leagues the public can already see has lost the one fact
      // staging exists to control.
      await page.goto("/");
      const staged = page.getByRole("link", {
        name: /Harbor Rec Hockey League/,
      });
      await expect(staged).toBeVisible();
      await expect(staged).toContainText("Not yet public");
      // Oceanview is published, so it carries no badge — the control that says
      // the badge tracks visibility rather than merely marking every row.
      await expect(
        page.getByRole("link", { name: /Oceanview Beer Hockey League/ }),
      ).not.toContainText("Not yet public");
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
      await signInAs(page, "Scorekeeper");

      const res = await page.goto("/harbor");
      expect(res?.status()).toBe(200);
      // ⚠️ THE 200 IS THE ASSERTION. This used to also check for an "All leagues"
      // link, which lives in the site header's account cluster — and a
      // SCOREKEEPER no longer gets that header at all: `[league]/layout` swaps it
      // for `ScorekeeperChrome`, deliberately, because a shared account must not
      // be offered a Password link. Keeping that check would pin chrome this role
      // is specifically not meant to have.
      //
      // The page rendering rather than 404ing is what "opens for a member" means,
      // and the staged-league guard is what this test is about.
      await expect(page.getByRole("link", { name: /Tonight/ })).toBeVisible();

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
      // ⚠️ A SCOREKEEPER, so the landing is `/tonight`, not the picker.
      // The label does not say "scorekeeper" anywhere, which is exactly how this
      // one got missed when the landing changed.
      await signInAs(page, "One-league scorer");
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

    await signInAs(page, "Manager");

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

  // ── A manage URL's league is enforced, not decorative ─────────────────────
  //
  // All three of these pages look their entity up by id with the admin client,
  // past RLS. The slug in the URL is the only thing asserting the entity belongs
  // to the league whose nav is wrapped around it.

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

  async function harborId(page: Page, listPath: string, hrefPrefix: string) {
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
    await signInAs(page, "Manager");
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
    await signInAs(page, "Manager");
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
    await signInAs(page, "Manager");
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
    await signInAs(page, "Manager");
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
    await signInAs(page, "Manager");

    await page.goto("/obhl/audit");
    const oceanviewBefore = await page.getByText(SUSPENSION).count();

    // Suspend a Harbor player: one audit entry, against Harbor.
    const teamSlug = await harborId(page, "/harbor/teams", "/harbor/teams/");
    await page.goto(`/harbor/teams/${teamSlug}`);
    // No tab to open: the editor is on the page for a manager. Scoped to its
    // region, because the public roster table sits above it with the same rows
    // and none of the buttons.
    const row = page
      .getByRole("region", { name: "Manage roster" })
      .locator("table tbody tr")
      .nth(2);
    // ⛔ THE CONTROL IS IN THE ROW'S DIALOG; THE BADGE IT SETS IS ON THE ROW.
    // So the dialog has to be shut before the row is read — Radix marks
    // everything behind a modal `aria-hidden`, and a badge assertion made over
    // an open one matches nothing regardless of what the roster says.
    await row.getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Suspend" }).click();
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
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
});

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
const staffRow = (page: Page) =>
  page.getByRole("navigation", { name: "Staff tools" });
const leagueNav = (page: Page) =>
  page.getByRole("navigation", { name: "League" });

test.describe("One chrome everywhere", () => {
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

/**
 * Every URL a manager may have bookmarked before a move. The redirects in
 * `next.config.ts` are the only thing keeping them alive, and nothing else in
 * the suite would notice one deleted.
 */
test.describe("Legacy URLs", () => {
  test("every legacy URL still lands on its page", async ({ page, request }) => {
    // `location` may be relative, so resolve it against a base before reading
    // the parts off it rather than assuming either shape.
    const locationOf = (res: { headers(): Record<string, string> }) =>
      new URL(res.headers()["location"], "http://localhost");

    const moved = [
      ["/obhl/manage/dashboard", "/obhl/dashboard"],
      ["/obhl/manage/people/duplicates", "/obhl/people/duplicates"],
      // Two hops: the prefix rule strips `/manage/`, and the schedule-builder
      // rows below move it under `/schedule`. This row asserts the first.
      ["/obhl/manage/schedule-builder/one-off", "/obhl/schedule-builder/one-off"],
      ["/obhl/manage/rules/edit", "/obhl/rules/edit"],
      // …and the second hop of that one: `/rules/edit` merged into `/rules`.
      ["/obhl/rules/edit", "/obhl/rules"],
      // A dynamic segment rides along rather than being swallowed.
      ["/harbor/manage/seasons/abc-123", "/harbor/seasons/abc-123"],
      // Zero trailing segments: the bare prefix lands on the league home.
      ["/obhl/manage", "/obhl"],
      // ⛔ Two explicit config rules, never one `:rest*` wildcard — zero-or-more
      // would also match the bare `/schedule-builder` and send it to the games
      // list instead of the season setup page (asserted at the end).
      ["/obhl/schedule-builder/repair", "/obhl/schedule/repair"],
      ["/obhl/schedule-builder/one-off", "/obhl/schedule/one-off"],
      // The score pages merged away; a game keeps the same id at either URL.
      ["/obhl/score", "/obhl/schedule"],
      ["/harbor/score/abc-123", "/harbor/games/abc-123/score"],
      // Creating a league belongs to no league, so it left `/:league/import`.
      ["/obhl/import", "/manage/leagues/new"],
    ];
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

    // The League Office keeps its `/manage/` prefix and is not a league: its
    // first segment is `manage`, so a careless source pattern eats it.
    // Anonymous, its own guard sends it to /login — it reached the route.
    const office = await request.get("/manage/office", { maxRedirects: 0 });
    expect(locationOf(office).pathname).toBe("/login");

    // ⛔ The bare builder URL is a redirect PAGE, not a config rule: a rule
    // cannot look up WHICH season to land on. Anonymous it would bounce to
    // /login, so it is driven signed in.
    await signInAs(page, "Manager");
    await page.goto("/obhl/schedule-builder");
    await expect(page).toHaveURL(/\/obhl\/seasons\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("heading", { name: /Season setup/ }),
    ).toBeVisible();
  });
});

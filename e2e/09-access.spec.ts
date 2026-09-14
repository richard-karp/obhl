/** Who may reach what: page guards, league scoping, and the refusals the database makes itself. */
/**
 * Path 15: Role-based access — scorekeepers and captains blocked from manager-only routes.
 */
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

type Db = ReturnType<typeof admin>;

/** An anonymous visitor's client: the publishable key and no session. */
function anonClient(): Db {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const TOTALS_VIEWS = ["v_skater_season_totals", "v_goalie_season_totals"] as const;

/**
 * The seeded captain's team, one of its scheduled games with nobody dressed
 * yet, and a skater from each side. An empty scoresheet, so a count after the
 * attempt means the attempt and nothing else.
 */
async function captainFixture(db: Db) {
  const { data: users } = await db.auth.admin.listUsers();
  const captainId = users!.users.find((u) => u.email === "captain@obhl.test")!.id;
  const { data: profile } = await db
    .from("profiles")
    .select("player_id")
    .eq("id", captainId)
    .single();
  const { data: row } = await db
    .from("team_players")
    .select("team_id, season_id")
    .eq("player_id", profile!.player_id)
    .eq("is_captain", true)
    .is("left_on", null)
    .limit(1)
    .single();
  const { data: games } = await db
    .from("games")
    .select("id, home_team_id, away_team_id")
    .eq("season_id", row!.season_id)
    .eq("status", "scheduled")
    .eq("is_draft", false)
    .or(`home_team_id.eq.${row!.team_id},away_team_id.eq.${row!.team_id}`)
    .order("scheduled_at", { ascending: false });
  let game: { id: string; home_team_id: string; away_team_id: string } | undefined;
  for (const g of games ?? []) {
    const { count } = await db
      .from("game_rosters")
      .select("id", { count: "exact", head: true })
      .eq("game_id", g.id);
    if (!count) {
      game = g;
      break;
    }
  }
  expect(game, "no scheduled game of the captain's team has an empty scoresheet").toBeTruthy();
  const otherTeamId =
    game!.home_team_id === row!.team_id ? game!.away_team_id : game!.home_team_id;
  const firstSkater = async (teamId: string) => {
    const { data } = await db
      .from("team_players")
      .select("player_id")
      .eq("season_id", row!.season_id)
      .eq("team_id", teamId)
      .is("left_on", null)
      .neq("position", "G")
      .limit(1)
      .single();
    return data!.player_id as string;
  };
  return {
    gameId: game!.id,
    ownTeamId: row!.team_id as string,
    ownPlayerId: await firstSkater(row!.team_id),
    otherTeamId,
    otherPlayerId: await firstSkater(otherTeamId),
  };
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

/** A signed-in ANON-key client — the same access a browser session has. */
async function signedInClient(email: string) {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error } = await client.auth.signInWithPassword({
    email,
    password: "hockey123",
  });
  if (error) throw new Error(`could not sign in as ${email}: ${error.message}`);
  return client;
}

async function leagueId(slug: string) {
  const { data } = await admin()
    .from("leagues")
    .select("id")
    .eq("slug", slug)
    .single();
  return data!.id as string;
}

/** The leagues a seeded account was actually confined to. */
async function leaguesOf(displayName: string): Promise<string[]> {
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

/** The single-league manager's league, and one they are not in. */
let LEAD_IN = "";
let LEAD_OUT = "";
/** The same pair for the single-league scorekeeper. */
let SCORER_IN = "";
let SCORER_OUT = "";

/** The one league an account is confined to — or a failure that names why. */
function theOneLeague(slugs: string[], who: string): string {
  if (slugs.length !== 1) {
    throw new Error(
      `${who} must belong to exactly one league (found ${slugs.length}). ` +
        `Every test in this file derives "a league you are in" from that — see ` +
        `scripts/seed-users.mjs.`,
    );
  }
  return slugs[0];
}

/**
 * Submit and wait for the action to actually finish.
 *
 * Every assertion below is about something NOT being written, and a DB read
 * fired straight after `click()` races the action — it reads "nothing yet"
 * and the test passes whether the guard is there or not. That is how the
 * first version of these tests passed against a deliberately broken guard.
 */
async function submitAndSettle(page: Page, click: Promise<unknown>) {
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await click;
  await posted;
}

/**
 * Point a hidden form field at something the server must refuse, and prove it
 * took before anyone submits.
 *
 * Setting `.value` on a React-rendered input before hydration lands is undone
 * when React takes over, and the form then posts its ORIGINAL value. Both ways
 * that can go have now been seen on CI and neither on a laptop, where
 * hydration always wins the race:
 *
 *  - where the original value is forbidden too, the action is refused for the
 *    wrong reason, or not at all, and the test fails somewhere confusing;
 *  - where the original value is PERMITTED — a co-manager's own Remove — the
 *    action quietly succeeds and the test passes without the attack ever
 *    happening. That one is the dangerous half: it proves nothing and says so
 *    nowhere.
 *
 * So settle, set, and assert. Never submit an unverified tamper.
 */
async function tamper(page: Page, field: Locator, value: string) {
  await page.waitForLoadState("networkidle");
  await field.evaluate(
    (el, v) => ((el as HTMLInputElement).value = v),
    value,
  );
  await expect(field).toHaveValue(value);
}

/** Roster rows whose team and season belong to different leagues — always 0. */
async function crossLeagueRosterRows(db: ReturnType<typeof admin>) {
  const { data } = await db
    .from("team_players")
    .select(
      "id, teams!team_players_team_id_fkey!inner(league_id), seasons!inner(league_id)",
    );
  return (data ?? []).filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r: any) => r.teams?.league_id !== r.seasons?.league_id,
  ).length;
}

/** A team page in the league whose form the test will tamper with. */
async function teamRosterUrl(page: Page, slug: string) {
  await page.goto(`/${slug}/teams`);
  const href = await page
    .locator(`a[href^="/${slug}/teams/"]`)
    .first()
    .getAttribute("href");
  return href!;
}

/**
 * ...which for a manager IS the editor: the forms are on the page, with no
 * tab to open. Waits for the region so the tampering below cannot race the
 * server render.
 */
async function openRosterEditor(page: Page, slug: string) {
  await page.goto(await teamRosterUrl(page, slug));
  await expect(
    page.getByRole("region", { name: "Manage roster" }),
  ).toBeVisible();
}

/**
 * Path 16: per-league routing — the league lives in the URL, so a link to one
 * league is a link to that league for whoever opens it.
 *
 * Assumes both seeded leagues: `obhl` (Oceanview, 6 teams) and `harbor`
 * (Harbor Rec, 4 teams). They share no team names, which is what makes the
 * bleed test meaningful.
 */
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
    // cookie-default league (obhl) and 11-schedule-build regenerates its
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
    // The confinement is DERIVED, not assumed. `09-access.spec.ts`
    // rejects hardcoding it, and if the seed ever moved this account into harbor
    // the assertion below would fail for a reason that has nothing to do with the
    // guard it is testing.
    expect(await leaguesOf("Single League Scorer")).not.toContain(
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
    const since = new Date().toISOString();
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

    // `update_player_status` is audited with `void logAudit` — the action returns
    // before the row exists, so wait for it rather than racing the audit page.
    await expect
      .poll(
        async () => {
          const { count } = await admin()
            .from("audit_log")
            .select("id", { count: "exact", head: true })
            .eq("action", "update_player_status")
            .gte("created_at", since);
          return count ?? 0;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);

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
});

/**
 * Path 17: per-league access control — a staff account belongs to leagues
 * (`profile_leagues`), and a role is only usable inside them.
 *
 * The rest of the suite cannot catch this class of bug. It signs in as
 * `manager@obhl.test`, who is a member of every seeded league, so a guard that
 * checks membership and a guard that checks nothing behave identically. Every
 * test here drives an account that belongs to exactly ONE seeded league.
 *
 * Which league that is, this file does not say. Its subject is "a league you
 * belong to" versus "one you do not", and those are roles in the scenario, not
 * particular leagues — so they are derived from the seeded memberships below.
 * Naming them would mean that flipping the seed's confinement leaves every test
 * here navigating to a league the account IS in and expecting a refusal, which
 * then fails for a reason that has nothing to do with the guard under test.
 */
test.describe("Path 17 — Per-league membership", () => {
  test.beforeAll(async () => {
    const { data: all } = await admin().from("leagues").select("slug");
    const slugs = (all ?? []).map((l) => l.slug as string);
    LEAD_IN = theOneLeague(
      await leaguesOf("Single League Manager"),
      "Single League Manager",
    );
    SCORER_IN = theOneLeague(
      await leaguesOf("Single League Scorer"),
      "Single League Scorer",
    );
    LEAD_OUT = slugs.find((slug) => slug !== LEAD_IN) ?? "";
    SCORER_OUT = slugs.find((slug) => slug !== SCORER_IN) ?? "";
    // Was the test "the fixture still has the shape these tests need".
    expect(LEAD_OUT, "need a second league to be refused from").toBeTruthy();
    expect(SCORER_OUT).toBeTruthy();
    // People & Roles compares two leagues' staff lists, which says nothing
    // unless the two confined accounts sit in different ones.
    expect(SCORER_IN).not.toBe(LEAD_IN);
  });

  // ── The app guards: every manage page under a league you're not in ────────

  /** Swapped for `LEAD_OUT` inside each test: titles exist before `beforeAll` runs. */
  const OUT = "__another_league__";

  const PAGE_REFUSALS: {
    who: Role | "anonymous";
    path: string;
    lands: string | RegExp;
  }[] = [
    // A manager of another league: the role is right, the membership is not.
    //
    // NOT "/teams": the roster editor merged into the public team page, so a
    // manager of another league SEES it, like `/rules`. What they must not get
    // is the Manage tab — asserted on its own below.
    //
    // ⚠️ NOT the bare "/schedule", even though its own CHILDREN are listed just
    // above — and that is not an oversight. `/score` merged into it, so the
    // games list is public: a scorekeeper or a manager of ANOTHER league sees it
    // like any visitor, and what they must not get is a Score button or the
    // edit panel, asserted below. The children are manager-only pages that
    // happen to live under a public parent, which the two route groups make
    // possible — see `(manage)/schedule/`.
    //
    // ⛔ NOT "/schedule-builder" any more either. It is a redirect page now, so
    // a manager of another league is bounced by ITS guard before the redirect
    // runs — a refusal, but to /login-or-home rather than from the page under
    // test, which would make this assertion prove something else.
    //
    // NOT "/rules": it merged into the public page, so a manager of another
    // league now SEES it like any visitor. What they must not get is the
    // editor, and that is asserted on its own below — a redirect assertion here
    // would have quietly become a test of nothing.
    //
    // NOT "/import": it is not under a league any more. It never imported INTO
    // the league in its URL — it creates a new one — so it moved to
    // `/manage/leagues/new`, where the guard is `requireManager()` and a manager
    // of another league is ADMITTED. Asserting a refusal here would now be
    // asserting the opposite of the intended behaviour; the admission is tested
    // in `03-season-setup.spec.ts` instead.
    { who: "One-league mgr", path: `/${OUT}/dashboard`, lands: "/" },
    { who: "One-league mgr", path: `/${OUT}/people`, lands: "/" },
    { who: "One-league mgr", path: `/${OUT}/seasons`, lands: "/" },
    { who: "One-league mgr", path: `/${OUT}/schedule/one-off`, lands: "/" },
    { who: "One-league mgr", path: `/${OUT}/schedule/repair`, lands: "/" },
    { who: "One-league mgr", path: `/${OUT}/announcements`, lands: "/" },
    { who: "One-league mgr", path: `/${OUT}/audit`, lands: "/" },
    // A scorekeeper: the membership is right, the role is not.
    { who: "Scorekeeper", path: "/obhl/seasons", lands: "/" },
    { who: "Scorekeeper", path: "/obhl/audit", lands: "/" },
    { who: "Scorekeeper", path: "/obhl/people", lands: "/" },
    // Nobody at all.
    { who: "anonymous", path: "/obhl/dashboard", lands: /\/login/ },
  ];

  for (const r of PAGE_REFUSALS) {
    test(`${r.who} is refused at ${r.path.replace(OUT, "<another league>")}`, async ({
      page,
    }) => {
      // The picker, where a wrong role or a wrong league lands: the one page
      // that needs no league.
      if (r.who !== "anonymous") await signInAs(page, r.who);
      await page.goto(r.path.replace(OUT, LEAD_OUT));
      await expect(page).toHaveURL(r.lands);
    });
  }

  test("a manager of one league reaches their own league's tools", async ({
    page,
  }) => {
    // The control for every refusal below: the same account, the same role, a
    // league it belongs to. Without this a guard that refused everything would
    // look like a guard that works.
    await signInAs(page, "One-league mgr");
    await page.goto(`/${LEAD_IN}/dashboard`);
    await expect(page).toHaveURL(`/${LEAD_IN}/dashboard`);
    await expect(page.getByRole("heading", { name: "Manage" })).toBeVisible();

    await page.goto(`/${LEAD_IN}/seasons`);
    await expect(page).toHaveURL(`/${LEAD_IN}/seasons`);
    await expect(page.getByRole("heading", { name: "Seasons" })).toBeVisible();
  });

  // ⚠️ The SERVER path — a manager of another league reaching `saveRules` itself
  // — is not tested here, and deliberately so. It is covered by
  // `src/lib/actions/league-guards.test.ts`, which asserts every exported action
  // reaches a league guard; removing `requireLeagueManager` from `saveRules`
  // turns that test red (watched, 2026-09-05). A review read this file alone,
  // saw the two tests above cover only the affordance and the RLS half, and
  // concluded the guard was unprotected. It is not — but it is protected
  // somewhere else, which is worth saying here rather than re-deriving.

  test("a scorekeeper cannot score another league's games", async ({
    page,
  }) => {
    // The first leak the handoff names: the role is instance-wide, so a
    // scorekeeper for one league could open the other league's scoresheet and
    // score its games. `/score` is one of only two guards that ever admitted a
    // non-manager role, which is why it gets its own test.
    await signInAs(page, "One-league scorer");
    await page.goto(`/${SCORER_IN}/schedule`);
    await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();
    const href = await page
      .locator(`a[href^="/${SCORER_IN}/games/"][href$="/score"]`)
      .first()
      .getAttribute("href");
    await page.goto(href!);
    await expect(page).toHaveURL(new RegExp(`/${SCORER_IN}/games/.+/score`));

    // The other league's schedule is PUBLIC now, so they see it — but with no
    // Score button anywhere on it. That is the affordance half.
    await page.goto(`/${SCORER_OUT}/schedule`);
    await expect(page).toHaveURL(`/${SCORER_OUT}/schedule`);
    // Every scoresheet link, not just the ones labelled "Score": a finished game
    // says "Edit" and a cancelled one says "Manage", so a name-based assertion
    // would report zero on a schedule that was handing out both.
    await expect(page.locator('a[href$="/score"]')).toHaveCount(0);

    // And the half that matters: the same game id under a league they are not
    // in, which is what proves the refusal is about the league rather than
    // about the page being broken.
    await page.goto(href!.replace(`/${SCORER_IN}/`, `/${SCORER_OUT}/`));
    await expect(page).toHaveURL("/");
  });

  test("a game in another league is not scoreable", async ({ page }) => {
    // Detail pages take an id, and the id says nothing about its league; the
    // slug in the URL is the claim, and the guard is what checks it.
    await signInAs(page, "Manager");
    await page.goto(`/${LEAD_OUT}/schedule`);
    const href = await page
      .locator(`a[href^="/${LEAD_OUT}/games/"][href$="/score"]`)
      .first()
      .getAttribute("href");

    await signInAs(page, "One-league mgr");
    await page.goto(href!);
    await expect(page).toHaveURL("/");
  });

  // ── People & Roles is this league's staff, and Remove is not a delete ─────

  test("People & Roles lists this league's staff only", async ({ page }) => {
    await signInAs(page, "Manager");

    // `exact` throughout. These assertions are about which addresses are
    // ABSENT, and a substring match finds an address that is not there — which
    // reads as exactly the leak this test exists to catch.
    const cell = (p: Page, email: string) =>
      p.getByRole("cell", { name: email, exact: true });

    await page.goto(`/${LEAD_IN}/people`);
    await expect(cell(page, "single-league-lead@obhl.test")).toBeVisible();
    await expect(cell(page, "manager@obhl.test")).toBeVisible();

    // The same page under a league they are not staff of: not listed there,
    // and so not editable or removable there either.
    await page.goto(`/${SCORER_IN}/people`);
    await expect(cell(page, "manager@obhl.test")).toBeVisible();
    await expect(cell(page, "single-league-scorer@obhl.test")).toBeVisible();
    await expect(cell(page, "single-league-lead@obhl.test")).toHaveCount(0);

    // …and the mirror image, so neither list is merely the whole table.
    await page.goto(`/${LEAD_IN}/people`);
    await expect(cell(page, "single-league-scorer@obhl.test")).toHaveCount(0);
  });

  test("Remove takes a person out of this league and leaves the account", async ({
    page,
  }) => {
    const scorekeeper = "scorekeeper@obhl.test";
    const from = await leagueId(LEAD_OUT);
    const db = admin();
    const memberships = async () => {
      const { data: prof } = await db
        .from("profiles")
        .select("id, display_name")
        .eq("display_name", "Score Keeper")
        .single();
      const { data } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", prof!.id);
      return { id: prof!.id, leagues: (data ?? []).map((r) => r.league_id) };
    };

    const before = await memberships();
    expect(before.leagues).toContain(from);

    try {
      await signInAs(page, "Manager");
      await page.goto(`/${LEAD_OUT}/people`);
      await page
        .locator("table tbody tr")
        .filter({ hasText: scorekeeper })
        .getByRole("button", { name: "Remove" })
        .click();
      await expect(page.getByText(scorekeeper)).toHaveCount(0);

      // Gone from THIS league only. Removing used to call
      // auth.admin.deleteUser, which does not come back.
      const after = await memberships();
      expect(after.id).toBe(before.id);
      expect(after.leagues).not.toContain(from);
      expect(after.leagues.length).toBe(before.leagues.length - 1);

      await page.goto(`/${LEAD_IN}/people`);
      await expect(page.getByText(scorekeeper)).toBeVisible();
    } finally {
      await db
        .from("profile_leagues")
        .upsert(
          { profile_id: before.id, league_id: from },
          { onConflict: "profile_id,league_id" },
        );
    }
  });

  test("adding an existing account cannot rewrite the role it holds elsewhere", async ({
    page,
  }) => {
    // "Add a staff account" reaches an account that already exists: createUser
    // fails on a known address, the id is looked up, and the profile is then
    // upserted. `profiles.role` is ONE instance-wide column (0009 reads it as
    // the role source; 0010's hook copies it into the JWT), so that upsert
    // rewrites the role the account uses in EVERY league it belongs to.
    //
    // The victim here belongs only to a league this manager is not in, and the
    // fixture test above asserts those two leagues differ. Granting them
    // `league_manager` therefore makes them a manager of a league the actor
    // cannot reach — through the ordinary form, with no tampering.
    //
    // createStaffAccount is the one action in people.ts that never calls
    // `isMemberOf`; updateStaffRole and removeStaff both do.
    const victim = "single-league-scorer@obhl.test";
    const db = admin();
    const outsideLeague = await leagueId(LEAD_IN);

    const { data: before } = await db
      .from("profiles")
      .select("id, role, display_name")
      .eq("display_name", "Single League Scorer")
      .single();
    // State the precondition rather than assume it: if the seed ever makes this
    // account a manager, the upsert below is a no-op and the test would pass
    // while proving nothing.
    expect(before!.role, "victim must start as a non-manager").toBe(
      "scorekeeper",
    );

    const memberships = async () => {
      const { data } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", before!.id);
      return (data ?? []).map((r) => r.league_id as string);
    };
    expect(await memberships()).not.toContain(outsideLeague);

    try {
      await signInAs(page, "One-league mgr");
      await page.goto(`/${LEAD_IN}/people`);

      const card = page
        .locator('[data-slot="card"]')
        .filter({ hasText: "Add a staff account" });
      await card.getByLabel("Email").fill(victim);
      // Their own display name, so the blast radius of a passing-today run is
      // the role alone. Left blank this field defaults to the email address and
      // overwrites the column that `beforeAll` derives the fixture from.
      await card.getByLabel("Display name").fill(before!.display_name!);
      await card.getByRole("combobox").click();
      await page.getByRole("option", { name: "League manager" }).click();
      await submitAndSettle(
        page,
        card.getByRole("button", { name: "Add staff account" }).click(),
      );

      // The refusal is VISIBLE, and asserted before the database checks. The
      // two below can both hold on a form that never submitted at all, which
      // would make this test pass while proving nothing once the guard lands —
      // the inverse of the vacuous-pass trap described above.
      //
      // Which refusal: the victim holds `scorekeeper` and this form submits
      // `league_manager`, so the role-mismatch branch answers first and the
      // `mayWriteProfileOf` check below it never runs. That one is the narrower
      // second layer — it decides only the case where an existing login has no
      // role to compare against — so naming its message here asserted a guard
      // this fixture cannot reach, while the escalation was in fact refused.
      await expect(
        card.getByText(/already has an account as scorekeeper/),
      ).toBeVisible();

      // The subject of the test: a manager of one league changed what an
      // account is allowed to do in another.
      //
      // Soft, both of them, so a failing run reports the whole effect rather
      // than stopping at the first half of it.
      const { data: after } = await db
        .from("profiles")
        .select("role")
        .eq("id", before!.id)
        .single();
      expect
        .soft(
          after!.role,
          "a manager of another league rewrote this account's global role",
        )
        .toBe("scorekeeper");

      // And did not hand themselves the membership either.
      expect
        .soft(await memberships(), "…and granted it their own league")
        .not.toContain(outsideLeague);
    } finally {
      await db
        .from("profiles")
        .update({ role: before!.role, display_name: before!.display_name })
        .eq("id", before!.id);
      await db
        .from("profile_leagues")
        .delete()
        .eq("profile_id", before!.id)
        .eq("league_id", outsideLeague);
    }
  });

  test("a manager cannot change the role of someone who works a league they don't share", async ({
    page,
  }) => {
    // The SECOND step of the same escalation, and the reason refusing the
    // profile write above does not close it.
    //
    // Step one is permitted on purpose: adding an existing account at the role
    // it already holds grants membership and touches no profile — that is how
    // one person works two leagues. But it also makes the actor share a league
    // with them, so `isMemberOf` then passes in `updateStaffRole`, and
    // `profiles.role` is instance-wide, so whatever that writes lands in the
    // league the actor cannot see.
    //
    // BOTH directions are driven, because the column does not care which way it
    // is pointed: `league_manager`, which hands the victim authority in their
    // own league, and `captain`, which takes their scorekeeping there away.
    // Neither is this manager's to decide, and a guard that only watches for
    // promotions lets the second one through.
    //
    // `mayWriteProfileOf` tests CONTAINMENT for exactly this reason. An overlap
    // test cannot catch it — step one creates the very sharing it looks for —
    // and neither can RLS: 0032's `shares_league_with(id)` permits the
    // identical sequence for the identical reason.
    const victim = "single-league-scorer@obhl.test";
    // Its own address, sharing no substring with a seeded one — see
    // `scripts/seed-users.mjs` on why that matters to a `hasText` row filter.
    const decoyEmail = `role-decoy-${Date.now()}@obhl.test`;
    const db = admin();
    const shared = await leagueId(LEAD_IN);
    const theirs = await leagueId(SCORER_IN);

    const { data: before } = await db
      .from("profiles")
      .select("id, role, display_name")
      .eq("display_name", "Single League Scorer")
      .single();
    expect(before!.role, "victim must start as a non-manager").toBe(
      "scorekeeper",
    );

    /** The add form, filled and submitted, on a page fresh enough to fill. */
    async function addStaff(email: string, name: string, roleLabel: string) {
      await page.goto(`/${LEAD_IN}/people`);
      const card = page
        .locator('[data-slot="card"]')
        .filter({ hasText: "Add a staff account" });
      await card.getByLabel("Email").fill(email);
      await card.getByLabel("Display name").fill(name);
      await card.getByRole("combobox").click();
      await page.getByRole("option", { name: roleLabel }).click();
      await submitAndSettle(
        page,
        card.getByRole("button", { name: "Add staff account" }).click(),
      );
      return card;
    }

    let decoyId: string | null = null;
    try {
      await signInAs(page, "One-league mgr");

      // ── Step 1: the permitted grant ──────────────────────────────────────
      //
      // Their own display name: the add form writes no profile on this path,
      // but leaving it blank would default the column to the email address that
      // `beforeAll` derives the whole fixture from.
      const card = await addStaff(victim, before!.display_name!, "Scorekeeper");
      // Asserted, not assumed. If step one were refused, step two would be
      // refused for THAT reason and this test would prove nothing.
      await expect(card.getByText(/now works this league too/)).toBeVisible();

      // ── Step 2: the page offers no way to spend it ───────────────────────
      await page.reload();
      const row = page.locator("table tbody tr").filter({ hasText: victim });
      await expect(
        row,
        "the grant should have put them in this table",
      ).toHaveCount(1);
      await expect(
        row.getByLabel("Change role"),
        "no role on this row is a manager of one league's to change",
      ).toHaveCount(0);
      await expect(row.getByText("Also works another league")).toBeVisible();

      // ── Step 3: and the server refuses it without the page's help ────────
      //
      // Withholding the control is a courtesy to the manager, not a control on
      // the request. So the attack needs a row this manager may still edit, and
      // the only kind left is one whose leagues are all theirs — an account
      // created here and nowhere else. It exists to carry the tampered id.
      await addStaff(decoyEmail, "Role Decoy", "Scorekeeper");
      const { data: decoy } = await db
        .from("profiles")
        .select("id")
        .eq("display_name", "Role Decoy")
        .single();
      decoyId = decoy!.id as string;

      for (const forged of ["league_manager", "captain"] as const) {
        await page.goto(`/${LEAD_IN}/people`);
        const decoyRow = page
          .locator("table tbody tr")
          .filter({ hasText: decoyEmail });
        // By the select, not by `league_id` — Remove carries that too, and this
        // row, unlike a manager's, renders both forms.
        const form = decoyRow.locator("form").filter({
          has: page.locator('select[name="role"]'),
        });
        // The decoy's own id would be a PERMITTED change, so an unapplied
        // tamper rewrites the decoy, leaves the victim alone, and passes every
        // check below without the attack ever happening. See `tamper`.
        await tamper(page, form.locator('input[name="id"]'), before!.id);
        await submitAndSettle(
          page,
          form.locator('select[name="role"]').selectOption(forged),
        );

        // Soft, so a failing run reports both halves rather than the first.
        const { data: after } = await db
          .from("profiles")
          .select("role")
          .eq("id", before!.id)
          .single();
        expect
          .soft(
            after!.role,
            `a manager of one league wrote ${forged} into an account working another`,
          )
          .toBe("scorekeeper");
        // …and the POST carried the tampered id rather than the decoy's own,
        // which is what makes the line above mean anything.
        const { data: decoyAfter } = await db
          .from("profiles")
          .select("role")
          .eq("id", decoyId)
          .single();
        expect
          .soft(decoyAfter!.role, "the tamper did not reach the server")
          .toBe("scorekeeper");
      }

      // Refusing the change must not cost them the league they came from.
      const { data: still } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", before!.id);
      expect((still ?? []).map((r) => r.league_id)).toContain(theirs);
    } finally {
      await db
        .from("profiles")
        .update({ role: before!.role, display_name: before!.display_name })
        .eq("id", before!.id);
      await db
        .from("profile_leagues")
        .delete()
        .eq("profile_id", before!.id)
        .eq("league_id", shared);
      // The decoy is this test's own litter. Deleting the login takes the
      // profile and its membership with it — both cascade.
      if (decoyId) await db.auth.admin.deleteUser(decoyId);
    }
  });

  test("a manager can still promote someone whose leagues they all share", async ({
    page,
  }) => {
    // The control for the test above. `mayWriteProfileOf` refusing every role
    // change would satisfy that one exactly as well as a correct guard does,
    // and handing a second person a manager account is the flow the whole
    // membership model exists to support — so it has to be shown working.
    //
    // Both accounts here are seeded into every league, so containment holds and
    // the promotion reaches no league the actor is not already a manager of.
    const subject = "scorekeeper@obhl.test";
    const db = admin();

    const { data: before } = await db
      .from("profiles")
      .select("id, role")
      .eq("display_name", "Score Keeper")
      .single();
    expect(before!.role, "control subject must start as a non-manager").toBe(
      "scorekeeper",
    );

    try {
      await signInAs(page, "Manager");
      await page.goto(`/${LEAD_IN}/people`);

      const row = page.locator("table tbody tr").filter({ hasText: subject });
      const select = row.getByLabel("Change role");
      // Rendered at all here, unlike the row in the test above, and with the
      // manager option on it.
      await expect(
        select.locator('option[value="league_manager"]'),
      ).toHaveCount(1);

      await submitAndSettle(page, select.selectOption("league_manager"));

      const { data: after } = await db
        .from("profiles")
        .select("role")
        .eq("id", before!.id)
        .single();
      expect(after!.role, "the permitted promotion was refused too").toBe(
        "league_manager",
      );
    } finally {
      await db
        .from("profiles")
        .update({ role: before!.role })
        .eq("id", before!.id);
    }
  });

  // ── Server actions, reached with another league's id ──────────────────────
  //
  // The gap the first version of this file could not cover. A manage form
  // carries its ids as hidden inputs, so rewriting one and submitting goes
  // through the genuine action endpoint — no hand-made POST and no action id
  // needed — which is the only way an action's guard gets exercised against an
  // id the UI would never offer it.
  //
  // Both run as `Manager`, who belongs to BOTH leagues on purpose: that is the
  // case a per-id membership check cannot catch, because each id passes on its
  // own and only the requirement that they name the SAME league refuses it.

  test("a roster add cannot name another league's team", async ({ page }) => {
    const db = admin();
    const { data: foreignTeam } = await db
      .from("teams")
      .select("id, name")
      .eq("league_id", await leagueId(LEAD_OUT))
      .limit(1)
      .single();

    const first = `Smuggled${Date.now()}`;
    try {
      await signInAs(page, "Manager");
      await openRosterEditor(page, LEAD_IN);

      const form = page.locator("form").filter({
        has: page.locator('input[name="first_name"]'),
      });
      // The season stays the page's own; only the team is swapped. Guarding
      // the season alone passed this, and `is_captain` rides in the same
      // payload.
      await tamper(
        page,
        form.locator('input[name="team_id"]'),
        foreignTeam!.id,
      );
      await form.getByLabel("First name").fill(first);
      await form.getByLabel("Last name").fill("Player");
      await submitAndSettle(
        page,
        form.getByRole("button", { name: "Add player" }).click(),
      );

      // The refusal itself, asserted first: the guard redirects to the picker,
      // and unlike the DB checks below this one WAITS, so it fails loudly
      // rather than reading a write that has not landed yet.
      await expect(page).toHaveURL("/");

      // Nothing was written — not the roster row, and not even the player, since
      // the guard runs before the insert that would create one.
      const { data: players } = await db
        .from("players")
        .select("id")
        .eq("first_name", first);
      expect(players ?? []).toHaveLength(0);

      // A cross-league roster row is nonsense the schema cannot refuse on its
      // own: the two foreign keys are independent, so nothing but this guard
      // stops one league's team being rostered into another's season.
      expect(await crossLeagueRosterRows(db)).toBe(0);
    } finally {
      const { data: junk } = await db
        .from("players")
        .select("id")
        .eq("first_name", first);
      for (const p of junk ?? [])
        await db.from("players").delete().eq("id", p.id);
    }
  });

  /**
   * ⛔ TWO TESTS STOOD HERE AND ARE GONE (2026-09-11), WITH NO LOSS OF COVER.
   * They tampered with `setDefaultGoalie`'s hidden `id` to set and clear
   * another league's default goalie. `0049` dropped
   * `team_players.is_default_goalie` and that action with it, so both tests
   * aimed at something that no longer exists — keeping them would have meant
   * two green tests exercising nothing.
   *
   * ⚠️ THE EQUIVALENT GUARD FOR WHAT REPLACED IT IS NOT ASSERTED HERE YET, and
   * that is stated rather than left to be discovered. A night is now written by
   * `updateRosterPlayer`, which resolves the league from the ROW rather than
   * from anything the form carries — a stronger position than the one these
   * tested, since there is no `team_id`/`season_id` left on the form to lie
   * about.
   *
   * ⛔ AN EARLIER VERSION OF THIS NOTE GAVE A REASON THAT WAS NOT TRUE. It said
   * the refusal "surfaces as neither a redirect nor a status message through
   * `useActionState`". It does redirect — `requireLeagueManagerOf` calls
   * `redirect("/")` (`src/lib/auth/guards.ts`), and the `addRosterPlayer`
   * tampering test above asserts exactly that on an action dispatched the same
   * way. The real reason the test is absent is that the first attempt at it did
   * not submit the form it thought it was submitting, and it was dropped rather
   * than shipped green-and-meaningless. The gap is real and the fix is a test,
   * not a rewording of this paragraph.
   */

  // ── A second manager can be taken back out of a league ────────────────────

  test("a manager can be removed from a league, but never yourself", async ({
    page,
  }) => {
    const db = admin();
    const mine = await leagueId(LEAD_IN);
    const { data: target } = await db
      .from("profiles")
      .select("id")
      .eq("display_name", "Single League Manager")
      .single();
    const { data: self } = await db
      .from("profiles")
      .select("id")
      .eq("display_name", "League Manager")
      .single();

    try {
      await signInAs(page, "Manager");
      await page.goto(`/${LEAD_IN}/people`);

      // Your own row offers no Remove — it could drop you out of a league you
      // are the only way back into, and for a league's sole manager that row is
      // always this one.
      const ownRow = page
        .locator("table tbody tr")
        .filter({ hasText: "manager@obhl.test" });
      await expect(ownRow.getByRole("button", { name: "Remove" })).toHaveCount(
        0,
      );

      // …and the page not offering it is not the guard. Aim a real Remove form
      // at yourself and submit: the server has to be what refuses.
      const coRow = page
        .locator("table tbody tr")
        .filter({ hasText: "single-league-lead@obhl.test" });
      const removeForm = coRow.locator("form").filter({
        has: page.locator('input[name="league_id"]'),
      });
      // The original id here is a PERMITTED removal, so an unapplied tamper
      // removes the co-manager for real and the "still a member" check below
      // passes without the attack happening. See `tamper`.
      await tamper(page, removeForm.locator('input[name="id"]'), self!.id);

      await submitAndSettle(
        page,
        removeForm.getByRole("button", { name: "Remove" }).click(),
      );
      // The co-manager must still be here — proof the POST carried the tampered
      // id and was refused, not the original id and quietly honoured.
      await expect(
        page.getByRole("cell", {
          name: "single-league-lead@obhl.test",
          exact: true,
        }),
      ).toHaveCount(1);
      const { data: stillMine } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", self!.id)
        .eq("league_id", mine);
      expect(stillMine ?? []).toHaveLength(1);

      // The co-manager's row IS removable — that is how a second manager
      // account gets taken back.
      await page.goto(`/${LEAD_IN}/people`);
      const row = page
        .locator("table tbody tr")
        .filter({ hasText: "single-league-lead@obhl.test" });
      await expect(
        row.getByText("Role changed by a commissioner"),
      ).toBeVisible();
      await expect(row.getByLabel("Change role")).toHaveCount(0);
      await submitAndSettle(
        page,
        row.getByRole("button", { name: "Remove" }).click(),
      );

      await expect(
        page.getByRole("cell", {
          name: "single-league-lead@obhl.test",
          exact: true,
        }),
      ).toHaveCount(0);

      // The league went, the account did not.
      const { data: stillThere } = await db
        .from("profiles")
        .select("id, role")
        .eq("id", target!.id)
        .single();
      expect(stillThere!.role).toBe("league_manager");
      const { data: left } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", target!.id);
      expect(left ?? []).toHaveLength(0);
    } finally {
      await db
        .from("profile_leagues")
        .upsert(
          { profile_id: target!.id, league_id: mine },
          { onConflict: "profile_id,league_id" },
        );
    }
  });

  // ── The other half: RLS, for a session talking to PostgREST directly ──────
  //
  // The app guards gate the UI. A staff account also holds a real Supabase
  // session, and can address the API with it without going through a page at
  // all — so the same membership test has to live in the policies (0032), or
  // the app half would look finished and stop nothing.

  /**
   * The refusals the DATABASE makes, to a session talking to PostgREST with no
   * page in between. `arrange` runs on the admin client and returns the attempt,
   * the read-back that proves nothing landed, and the restore for a red run.
   *
   * ⛔ READ THE ROW, NOT THE ERROR. An RLS-refused UPDATE matches no rows and
   * reports no error, so an assertion on `error` passes whether the policy is
   * there or not.
   */
  type ApiRefusal = {
    title: string;
    /** The session's email, or null for an anonymous visitor. */
    as: string | null;
    arrange: (db: Db) => Promise<{
      attempt: (client: Db) => Promise<void>;
      assertRefused: (db: Db) => Promise<void>;
      restore?: (db: Db) => Promise<void>;
    }>;
  };

  const API_REFUSALS: ApiRefusal[] = [
    {
      title: "renaming a season in another league",
      as: "single-league-lead@obhl.test",
      arrange: async (db) => {
        const { data: foreign } = await db
          .from("seasons")
          .select("id, name")
          .eq("league_id", await leagueId(LEAD_OUT))
          .limit(1)
          .single();
        return {
          attempt: async (client) => {
            await client
              .from("seasons")
              .update({ name: "Hijacked" })
              .eq("id", foreign!.id);
          },
          assertRefused: async (db) => {
            const { data } = await db
              .from("seasons")
              .select("name")
              .eq("id", foreign!.id)
              .single();
            expect(data!.name).toBe(foreign!.name);
          },
          restore: async (db) => {
            await db
              .from("seasons")
              .update({ name: foreign!.name })
              .eq("id", foreign!.id);
          },
        };
      },
    },
    {
      title: "posting an announcement into another league",
      as: "single-league-lead@obhl.test",
      arrange: async () => {
        const title = `Hijack ${Date.now()}`;
        const foreignLeague = await leagueId(LEAD_OUT);
        return {
          attempt: async (client) => {
            await client
              .from("announcements")
              .insert({ league_id: foreignLeague, title, body: "no" });
          },
          assertRefused: async (db) => {
            const { data } = await db
              .from("announcements")
              .select("id")
              .eq("title", title);
            expect(data ?? []).toHaveLength(0);
          },
          restore: async (db) => {
            await db.from("announcements").delete().eq("title", title);
          },
        };
      },
    },
    {
      title: "overwriting another league's rules",
      as: "single-league-lead@obhl.test",
      arrange: async (db) => {
        const foreignLeague = await leagueId(LEAD_OUT);
        const { data: before } = await db
          .from("league_rules")
          .select("content")
          .eq("league_id", foreignLeague)
          .maybeSingle();
        return {
          attempt: async (client) => {
            await client
              .from("league_rules")
              .upsert(
                { league_id: foreignLeague, content: { hijacked: true } },
                { onConflict: "league_id" },
              );
          },
          assertRefused: async (db) => {
            const { data: after } = await db
              .from("league_rules")
              .select("content")
              .eq("league_id", foreignLeague)
              .maybeSingle();
            expect(after?.content ?? null).toEqual(before?.content ?? null);
          },
          restore: async (db) => {
            if (before) {
              await db
                .from("league_rules")
                .update({ content: before.content })
                .eq("league_id", foreignLeague);
            } else {
              await db.from("league_rules").delete().eq("league_id", foreignLeague);
            }
          },
        };
      },
    },
    {
      title: "writing a profile that also works a league the session does not",
      as: "single-league-lead@obhl.test",
      arrange: async (db) => {
        const shared = await leagueId(LEAD_IN);
        const { data: victim } = await db
          .from("profiles")
          .select("id, role, display_name")
          .eq("display_name", "Single League Scorer")
          .single();
        expect(victim!.role, "victim must start as a non-manager").toBe("scorekeeper");
        return {
          attempt: async (client) => {
            // Step 1 is PERMITTED, and asserted so: granting someone a league
            // you manage is the flow the membership model exists for. Refused,
            // step 2 would fail for that reason and prove nothing.
            const granted = await client
              .from("profile_leagues")
              .insert({ profile_id: victim!.id, league_id: shared })
              .select();
            expect(
              granted.error,
              "granting a league you manage should still be allowed",
            ).toBeNull();
            // `display_name`, not `role`: 0050 refuses every session role write,
            // so a role write here would pass without 0033's containment policy.
            await client
              .from("profiles")
              .update({ display_name: "Minted By Another League's Manager" })
              .eq("id", victim!.id);
          },
          assertRefused: async (db) => {
            const { data: after } = await db
              .from("profiles")
              .select("display_name")
              .eq("id", victim!.id)
              .single();
            expect(
              after!.display_name,
              "a session wrote another league's profile through containment",
            ).toBe(victim!.display_name);
          },
          restore: async (db) => {
            await db
              .from("profiles")
              .update({ display_name: victim!.display_name })
              .eq("id", victim!.id);
            await db
              .from("profile_leagues")
              .delete()
              .eq("profile_id", victim!.id)
              .eq("league_id", shared);
          },
        };
      },
    },
    {
      title: "rewriting its own role or player link",
      as: "single-league-scorer@obhl.test",
      arrange: async (db) => {
        // 0009's "own profile update" names no columns, so before 0050 any
        // signed-in account could make itself a manager, or link itself to
        // another league's captain. Measured on the local stack 2026-09-13.
        const { data: self } = await db
          .from("profiles")
          .select("id, role, player_id")
          .eq("display_name", "Single League Scorer")
          .single();
        const { data: players } = await db.from("players").select("id").limit(2);
        const other = (players ?? []).find((p) => p.id !== self!.player_id)!;
        return {
          attempt: async (client) => {
            await client
              .from("profiles")
              .update({ role: "league_manager" })
              .eq("id", self!.id);
            await client
              .from("profiles")
              .update({ player_id: other.id })
              .eq("id", self!.id);
          },
          assertRefused: async (db) => {
            const { data: after } = await db
              .from("profiles")
              .select("role, player_id")
              .eq("id", self!.id)
              .single();
            expect(after!.role).toBe(self!.role);
            expect(after!.player_id).toBe(self!.player_id);
          },
          restore: async (db) => {
            await db
              .from("profiles")
              .update({ role: self!.role, player_id: self!.player_id })
              .eq("id", self!.id);
          },
        };
      },
    },
    {
      title: "reading another league's audit log",
      as: "single-league-lead@obhl.test",
      arrange: async (db) => {
        // Reverting an audit entry is a write, so who can READ the log is who
        // can undo the league.
        const theirs = await leagueId(LEAD_OUT);
        const { count: exists } = await db
          .from("audit_log")
          .select("id", { count: "exact", head: true })
          .eq("league_id", theirs);
        expect(exists, "the other league has no audit entries to hide").toBeGreaterThan(0);
        let seen: number | null = null;
        return {
          attempt: async (client) => {
            const { count } = await client
              .from("audit_log")
              .select("*", { count: "exact", head: true })
              .eq("league_id", theirs);
            seen = count;
          },
          assertRefused: async () => {
            expect(seen ?? 0).toBe(0);
          },
        };
      },
    },
    {
      title: "reading the staff of a league it does not share",
      as: "single-league-lead@obhl.test",
      arrange: async () => {
        let visible = new Set<string>();
        return {
          attempt: async (client) => {
            const { data: rows } = await client.from("profiles").select("id");
            visible = new Set((rows ?? []).map((r) => r.id as string));
          },
          assertRefused: async (db) => {
            const { data: sharedMembers } = await db
              .from("profile_leagues")
              .select("profile_id")
              .eq("league_id", await leagueId(LEAD_IN));
            const allowed = new Set(
              (sharedMembers ?? []).map((r) => r.profile_id as string),
            );
            // ⚠️ PLUS EVERY ACCOUNT THAT BELONGS TO NO LEAGUE AT ALL. "manager
            // write profiles" is `for all`, so its USING clause applies to SELECT
            // too, and `contains_leagues_of` passes vacuously for an account in no
            // league — deliberately: adding a brand-new account writes a profile
            // that belongs to nothing yet.
            const { data: everyMembership } = await db
              .from("profile_leagues")
              .select("profile_id");
            const assigned = new Set(
              (everyMembership ?? []).map((r) => r.profile_id as string),
            );
            const { data: tiers } = await db.from("league_office").select("profile_id");
            const inOffice = new Set((tiers ?? []).map((r) => r.profile_id as string));
            const { data: everyProfile } = await db.from("profiles").select("id");
            for (const p of everyProfile ?? [])
              if (!assigned.has(p.id) && !inOffice.has(p.id)) allowed.add(p.id);

            expect(visible.size).toBeGreaterThan(0);
            for (const id of visible) expect(allowed.has(id)).toBe(true);

            // ⛔ AND THE OFFICE STAYS OUT. Both office accounts belong to no league,
            // so only the tier keeps them unreadable by a plain manager. The size
            // check stops an empty `league_office` read passing vacuously.
            expect(inOffice.size).toBeGreaterThan(0);
            for (const id of inOffice) expect(visible.has(id)).toBe(false);

            // Named: the set check cannot fail while every seeded account happens
            // to share a league with this one, and this account does not.
            const { data: outsider } = await db
              .from("profiles")
              .select("id")
              .eq("display_name", "Single League Scorer")
              .single();
            expect(visible.has(outsider!.id)).toBe(false);
          },
        };
      },
    },
    {
      // Ported from scripts/verify-auth.mjs: the one check it made that no spec did.
      title: "dressing a player on the other team as a captain",
      as: "captain@obhl.test",
      arrange: async (db) => {
        const cap = await captainFixture(db);
        const key = {
          game_id: cap.gameId,
          team_id: cap.otherTeamId,
          player_id: cap.otherPlayerId,
        };
        const dressed = async (d: Db) => {
          const { count } = await d
            .from("game_rosters")
            .select("id", { count: "exact", head: true })
            .eq("game_id", key.game_id)
            .eq("team_id", key.team_id)
            .eq("player_id", key.player_id);
          return count ?? 0;
        };
        expect(await dressed(db), "the fixture game must start empty").toBe(0);
        return {
          attempt: async (client) => {
            await client.from("game_rosters").insert(key);
          },
          assertRefused: async (db) => {
            expect(await dressed(db)).toBe(0);
          },
          restore: async (db) => {
            await db.from("game_rosters").delete().eq("game_id", key.game_id);
          },
        };
      },
    },
    {
      // Ported from scripts/verify-transfers.mjs (#3): RLS has to reach through
      // a security_invoker view nested inside another, or a staged league's
      // stats are public.
      title: "reading a staged league's season totals anonymously",
      as: null,
      arrange: async (db) => {
        const { data: league } = await db
          .from("leagues")
          .select("id")
          .eq("slug", "harbor")
          .single();
        const { data: season } = await db
          .from("seasons")
          .select("id")
          .eq("league_id", league!.id)
          .eq("is_active", true)
          .single();
        const rowsOf = async (client: Db, view: string) => {
          const { data } = await client
            .from(view)
            .select("player_id")
            .eq("season_id", season!.id);
          return (data ?? []).length;
        };
        // The control: while public, the visitor DOES read rows — so an empty
        // read below is the league going private, not an empty view.
        for (const view of TOTALS_VIEWS) {
          expect(await rowsOf(anonClient(), view), `${view} while public`).toBeGreaterThan(0);
        }
        await db.from("leagues").update({ is_public: false }).eq("id", league!.id);
        const seen: Record<string, number> = {};
        return {
          attempt: async (client) => {
            for (const view of TOTALS_VIEWS) seen[view] = await rowsOf(client, view);
          },
          assertRefused: async () => {
            for (const view of TOTALS_VIEWS) expect(seen[view], view).toBe(0);
          },
          restore: async (db) => {
            await db.from("leagues").update({ is_public: true }).eq("id", league!.id);
          },
        };
      },
    },
    {
      // Part 1's 0051, found live by its final review: a manager session could
      // store `teams/<team>.svg` as image/svg+xml in the PUBLIC logos bucket,
      // around `uploadTeamLogo`'s allowlist. The one test the owner added.
      title: "uploading an SVG straight to the logos bucket",
      as: "single-league-lead@obhl.test",
      arrange: async (db) => {
        const { data: team } = await db
          .from("teams")
          .select("id")
          .eq("league_id", await leagueId(LEAD_IN))
          .limit(1)
          .single();
        const name = `${team!.id}.svg`;
        const stored = async (d: Db) => {
          const { data } = await d.storage
            .from("logos")
            .list("teams", { search: name });
          return (data ?? []).filter((o) => o.name === name).length;
        };
        expect(await stored(db), "the fixture must start with no such object").toBe(0);
        return {
          attempt: async (client) => {
            await client.storage
              .from("logos")
              .upload(
                `teams/${name}`,
                new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], {
                  type: "image/svg+xml",
                }),
                { contentType: "image/svg+xml", upsert: true },
              );
          },
          assertRefused: async (db) => {
            expect(await stored(db)).toBe(0);
          },
          restore: async (db) => {
            await db.storage.from("logos").remove([`teams/${name}`]);
          },
        };
      },
    },
  ];

  for (const row of API_REFUSALS) {
    test(`the API refuses ${row.title}`, async () => {
      const db = admin();
      const client = row.as ? await signedInClient(row.as) : anonClient();
      const step = await row.arrange(db);
      try {
        await step.attempt(client);
        await step.assertRefused(db);
      } finally {
        await step.restore?.(db);
        if (row.as) await client.auth.signOut();
      }
    });
  }

  test("a session can still write its OWN league's rows through the API", async () => {
    // The control for the table above: policies that refused everything would
    // pass every row. The same session, its own league's season and rules.
    const client = await signedInClient("single-league-lead@obhl.test");
    const db = admin();
    const ownLeague = await leagueId(LEAD_IN);
    const { data: own } = await db
      .from("seasons")
      .select("id, name")
      .eq("league_id", ownLeague)
      .limit(1)
      .single();
    const { data: rules } = await db
      .from("league_rules")
      .select("content")
      .eq("league_id", ownLeague)
      .maybeSingle();
    try {
      const { data: updated, error } = await client
        .from("seasons")
        .update({ name: own!.name })
        .eq("id", own!.id)
        .select("id");
      expect(error).toBeNull();
      expect(updated ?? []).toHaveLength(1);

      const { data: allowed } = await client
        .from("league_rules")
        .upsert(
          { league_id: ownLeague, content: { control: true } },
          { onConflict: "league_id" },
        )
        .select("league_id");
      expect(allowed ?? []).toHaveLength(1);
    } finally {
      await db.from("seasons").update({ name: own!.name }).eq("id", own!.id);
      if (rules) {
        await db
          .from("league_rules")
          .update({ content: rules.content })
          .eq("league_id", ownLeague);
      } else {
        await db.from("league_rules").delete().eq("league_id", ownLeague);
      }
      await client.auth.signOut();
    }
  });

  test("a captain can still dress a player on their own team through the API", async () => {
    // Ported from scripts/verify-auth.mjs: the control for the captain row.
    const db = admin();
    const cap = await captainFixture(db);
    const client = await signedInClient("captain@obhl.test");
    try {
      await client.from("game_rosters").insert({
        game_id: cap.gameId,
        team_id: cap.ownTeamId,
        player_id: cap.ownPlayerId,
      });
      const { count } = await db
        .from("game_rosters")
        .select("id", { count: "exact", head: true })
        .eq("game_id", cap.gameId)
        .eq("team_id", cap.ownTeamId)
        .eq("player_id", cap.ownPlayerId);
      expect(count, "the captain's own-team write was refused too").toBe(1);
    } finally {
      await db.from("game_rosters").delete().eq("game_id", cap.gameId);
      await client.auth.signOut();
    }
  });

  test("an anonymous visitor can read a public league's season totals", async () => {
    // Ported from scripts/verify-transfers.mjs (#4). No migration grants SELECT
    // on these views, so whether anon holds it is settled by asking — the same
    // question a browser asks — not by reading information_schema.
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "harbor")
      .single();
    const { data: season } = await db
      .from("seasons")
      .select("id")
      .eq("league_id", league!.id)
      .eq("is_active", true)
      .single();
    for (const view of TOTALS_VIEWS) {
      const { data, error } = await anonClient()
        .from(view)
        .select("season_id")
        .eq("season_id", season!.id)
        .limit(1);
      expect(error?.code, `${view}: ${error?.message}`).not.toBe("42501");
      expect(data ?? [], `${view} returned no rows`).not.toHaveLength(0);
    }
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

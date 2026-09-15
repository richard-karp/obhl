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

function anonClient(): Db {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const TOTALS_VIEWS = ["v_skater_season_totals", "v_goalie_season_totals"] as const;

// A scheduled game of the captain's team with an empty scoresheet, so a count after the attempt
// means the attempt and nothing else.
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

// IN: the league the single-league manager (LEAD) or scorekeeper (SCORER) belongs to; OUT: another.
let LEAD_IN = "";
let LEAD_OUT = "";
let SCORER_IN = "";
let SCORER_OUT = "";

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

// Wait for the POST: every assertion here is about something NOT written, and a read fired straight
// after `click()` reads "nothing yet" and passes with the guard deleted.
async function submitAndSettle(page: Page, click: Promise<unknown>) {
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await click;
  await posted;
}

// A `.value` set before hydration is undone and the form posts its ORIGINAL value; where that value
// is permitted, the attack never happens and the test passes. So settle, set, and assert.
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

async function teamRosterUrl(page: Page, slug: string) {
  await page.goto(`/${slug}/teams`);
  const href = await page
    .locator(`a[href^="/${slug}/teams/"]`)
    .first()
    .getAttribute("href");
  return href!;
}

// A manager's team page is the editor. Waits for the region so a tamper cannot race the render.
async function openRosterEditor(page: Page, slug: string) {
  await page.goto(await teamRosterUrl(page, slug));
  await expect(
    page.getByRole("region", { name: "Manage roster" }),
  ).toBeVisible();
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
    // Sourced from Harbor, not Oceanview: the manage specs drive obhl, and nothing touches Harbor.
    // ⚠️ The results view: only a final game's row links (`game-row.tsx`); the default is Upcoming.
    await page.goto("/harbor/schedule?view=results");
    const href = await page
      .locator('a[href^="/harbor/games/"]')
      .first()
      .getAttribute("href");
    const gameId = href!.split("/").pop()!;

    await page.goto(`/harbor/games/${gameId}`);
    await expect(page.getByRole("heading", { name: /@/ })).toBeVisible();

    // The body, not the status: `(public)/loading.tsx` flushes a 200 shell before a page-level
    // `notFound()` runs, so only the body swaps.
    await page.goto(`/obhl/games/${gameId}`);
    await expect(page.getByText("That page couldn't be found.")).toBeVisible();
    await expect(page.getByRole("heading", { name: /@/ })).toHaveCount(0);
  });

  test("a staged league is invisible to the public and open to its own people", async ({
    page,
  }) => {
    // Both directions: leaking an unpublished league, or locking out the people staging it.
    await setHarborPublic(false);
    try {
      // Anonymous: indistinguishable from a slug nobody took. A redirect would confirm the league
      // exists, so this must be a 404.
      const anon = await page.goto("/harbor");
      expect(anon?.status()).toBe(404);
      const anonStandings = await page.goto("/harbor/standings");
      expect(anonStandings?.status()).toBe(404);

      await signInAs(page, "Manager");

      // A member, on the public side: renders, chrome and all.
      const asMember = await page.goto("/harbor");
      expect(asMember?.status()).toBe(200);
      await expect(
        page.getByRole("navigation", { name: "Staff tools" }),
      ).toBeVisible();

      // Teams must read past RLS: the public-read policies cover neither a staged league's seasons
      // nor its teams, so its manager would see an empty page.
      await page.goto("/harbor/teams");
      await expect(page.getByText("No teams enrolled yet")).toHaveCount(0);
      await expect(
        page.locator('a[href^="/harbor/teams/"]').first(),
      ).toBeVisible();

      await page.goto("/harbor/dashboard");
      await expect(page).toHaveURL("/harbor/dashboard");
      await expect(page.getByRole("heading", { name: "Manage" })).toBeVisible();

      // ⛔ The picker must list a staged league to its members, badged: `getPublicLeagues` alone hides
      // it, and the badge is the one fact staging exists to control.
      await page.goto("/");
      const staged = page.getByRole("link", {
        name: /Harbor Rec Hockey League/,
      });
      await expect(staged).toBeVisible();
      await expect(staged).toContainText("Not yet public");
      // The control: published Oceanview carries no badge, so the badge tracks visibility.
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
    // A non-manager MEMBER: without `leagues`' member read policy (0042) the row never resolves and
    // the app's any-member rule is never reached. The other staged tests cannot tell.
    await setHarborPublic(false);
    try {
      await signInAs(page, "Scorekeeper");

      const res = await page.goto("/harbor");
      expect(res?.status()).toBe(200);
      // ⚠️ The 200 is the assertion. Don't check the header's account cluster: a scorekeeper gets
      // `ScorekeeperChrome` instead, so a shared account is offered no Password link.
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
    // Membership, not sign-in. The confinement is derived, not assumed: if the seed moved this
    // account into harbor, the assertion would fail for a reason unrelated to the guard.
    expect(await leaguesOf("Single League Scorer")).not.toContain(
      "harbor",
    );
    await setHarborPublic(false);
    try {
      // ⚠️ A scorekeeper (the label doesn't say so), so the landing is `/tonight`, not the picker.
      await signInAs(page, "One-league scorer");
      const res = await page.goto("/harbor");
      expect(res?.status()).toBe(404);
    } finally {
      await setHarborPublic(true);
    }
  });

  // ── Writes land in the league whose page issued them. Driven on Harbor: obhl is also where a
  // broken resolver falls back, so a wrong-league write there looks correct.

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

  // ── A manage URL's league is enforced: these pages look their entity up by id past RLS, so
  // the slug is the only claim. A slug shared by BOTH leagues, since the seed shares no team names.
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
    await signInAs(page, "Manager");
    const slug = await harborId(page, "/harbor/teams", "/harbor/teams/");

    const own = await page.goto(`/harbor/teams/${slug}`);
    expect(own?.status()).toBe(200);
    const ownName = await page.locator("h1").first().innerText();

    // ⚠️ Not enough alone: the leagues share no team names, so this 404s even with `getTeamBySlug`'s
    // `league_id` filter deleted. The shared slug below catches that.
    await page.goto(`/obhl/teams/${slug}`);
    await expect(page.getByText("That page couldn't be found.")).toBeVisible();
    await expect(page.getByText(ownName, { exact: true })).toHaveCount(0);

    // ⚠️ Assert each page's NAME: an inequality check caught a dropped `league_id` only by accident
    // (`.maybeSingle()` errored on two rows, and both 404s compared equal).
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
    // The old URL names a team by id; answering for another league's team would leak its slug.
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

    // `request.get` with no redirects, not `page.goto`: a navigation follows the 308, so a wrong
    // redirect to a 404 would look like a refusal.
    const foreign = await request.get(`/obhl/rosters/${team!.id}`, {
      maxRedirects: 0,
    });
    expect(foreign.status()).toBe(404);
  });

  test("a game from another league is not scoreable under this one", async ({
    page,
  }) => {
    await signInAs(page, "Manager");
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
    // Reverting an audit entry is a write, so each league's log must hold only its own entries.
    const SUSPENSION = /Updated is suspended for/;
    await signInAs(page, "Manager");

    await page.goto("/obhl/audit");
    const oceanviewBefore = await page.getByText(SUSPENSION).count();

    // Suspend a Harbor player: one audit entry, against Harbor.
    const since = new Date().toISOString();
    const teamSlug = await harborId(page, "/harbor/teams", "/harbor/teams/");
    await page.goto(`/harbor/teams/${teamSlug}`);
    // Scoped to the editor region: the public roster table above it has the same rows, no buttons.
    const row = page
      .getByRole("region", { name: "Manage roster" })
      .locator("table tbody tr")
      .nth(2);
    // ⛔ Shut the dialog before reading the row's badge: Radix marks everything behind a modal
    // `aria-hidden`, so the assertion would match nothing whatever the roster says.
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

// ⛔ The chrome is not the guard: a hand-typed URL still reaches the page, and its own guard refuses,
// asserted by `PAGE_REFUSALS` below.
const staffRow = (page: Page) =>
  page.getByRole("navigation", { name: "Staff tools" });
const leagueNav = (page: Page) =>
  page.getByRole("navigation", { name: "League" });

test.describe("One chrome everywhere", () => {
  test("a manager of another league browsing this one gets no staff row", async ({
    page,
  }) => {
    // ⚠️ Membership, not role: this account is a `league_manager` in Harbor only, so gating the row
    // on `user.role` would hand them Oceanview's tools.
    await signInAs(page, "One-league mgr");

    await page.goto("/obhl");
    await expect(leagueNav(page).first()).toBeVisible();
    await expect(staffRow(page)).toHaveCount(0);
    // Still signed in: the account cluster is theirs in any league.
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    // And the league they DO belong to still offers the row.
    await page.goto("/harbor");
    await expect(staffRow(page)).toBeVisible();
  });
});

// Drives accounts in exactly ONE league; `manager@` is in all (`RUNBOOK.md` → Seed and fixtures).
// Which league is derived, never named: a flipped seed would fail these for the wrong reason.
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
    // Another league's manager. Not `/teams`, `/rules` or `/schedule`: public, nothing to refuse;
    // ⛔ nor `/schedule-builder`, a redirect page whose guard refuses before the page under test.
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
      // A wrong role or league lands on the picker, the one page that needs no league.
      if (r.who !== "anonymous") await signInAs(page, r.who);
      await page.goto(r.path.replace(OUT, LEAD_OUT));
      await expect(page).toHaveURL(r.lands);
    });
  }

  test("a manager of one league reaches their own league's tools", async ({
    page,
  }) => {
    // The control for these refusals: the same account and role, its own league. Without it a
    // guard that refused everything would look like one that works.
    await signInAs(page, "One-league mgr");
    await page.goto(`/${LEAD_IN}/dashboard`);
    await expect(page).toHaveURL(`/${LEAD_IN}/dashboard`);
    await expect(page.getByRole("heading", { name: "Manage" })).toBeVisible();

    await page.goto(`/${LEAD_IN}/seasons`);
    await expect(page).toHaveURL(`/${LEAD_IN}/seasons`);
    await expect(page.getByRole("heading", { name: "Seasons" })).toBeVisible();
  });

  // ⚠️ `saveRules`'s server guard is asserted in `src/lib/actions/league-guards.test.ts` (every
  // action reaches a league guard), not here; its absence from this file is not a gap.

  test("a scorekeeper cannot score another league's games", async ({
    page,
  }) => {
    // The role is instance-wide and `/score` admits a non-manager, so its league scoping gets a test.
    await signInAs(page, "One-league scorer");
    await page.goto(`/${SCORER_IN}/schedule`);
    await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();
    const href = await page
      .locator(`a[href^="/${SCORER_IN}/games/"][href$="/score"]`)
      .first()
      .getAttribute("href");
    await page.goto(href!);
    await expect(page).toHaveURL(new RegExp(`/${SCORER_IN}/games/.+/score`));

    // The other league's schedule is public, so they see it, with no Score button.
    await page.goto(`/${SCORER_OUT}/schedule`);
    await expect(page).toHaveURL(`/${SCORER_OUT}/schedule`);
    // Every scoresheet link, not just "Score": a final game says "Edit" and a cancelled one
    // "Manage", so a name-based check would report zero on a schedule handing out both.
    await expect(page.locator('a[href$="/score"]')).toHaveCount(0);

    // The same game id under a league they're not in: refused for the league, not a broken page.
    await page.goto(href!.replace(`/${SCORER_IN}/`, `/${SCORER_OUT}/`));
    await expect(page).toHaveURL("/");
  });

  test("a game in another league is not scoreable", async ({ page }) => {
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

    // `exact` throughout: these assert which addresses are ABSENT, and a substring match finds an
    // address that is not there.
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

      // Gone from THIS league only; the account stays.
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
    // `profiles.role` is one instance-wide column, so rewriting an existing account's profile changes
    // its role in EVERY league. The victim is only in a league this manager is not (`beforeAll`).
    const victim = "single-league-scorer@obhl.test";
    const db = admin();
    const outsideLeague = await leagueId(LEAD_IN);

    const { data: before } = await db
      .from("profiles")
      .select("id, role, display_name")
      .eq("display_name", "Single League Scorer")
      .single();
    // State the precondition: if the seed makes this account a manager, the upsert is a no-op and
    // the test passes while proving nothing.
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
      // Their own display name: left blank it defaults to the email and overwrites the column
      // `beforeAll` derives the fixture from.
      await card.getByLabel("Display name").fill(before!.display_name!);
      await card.getByRole("combobox").click();
      await page.getByRole("option", { name: "League manager" }).click();
      await submitAndSettle(
        page,
        card.getByRole("button", { name: "Add staff account" }).click(),
      );

      // The visible refusal first: the DB checks below also hold on a form that never submitted.
      // The role-mismatch branch answers first, so `mayWriteProfileOf`'s message is unreachable.
      await expect(
        card.getByText(/already has an account as scorekeeper/),
      ).toBeVisible();

      // Soft, both of them, so a failing run reports the whole effect.
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
    // Step one is permitted and makes the actor share a league, so only `mayWriteProfileOf`'s
    // CONTAINMENT check refuses step two. Both directions: a promotion-only guard passes `captain`.
    const victim = "single-league-scorer@obhl.test";
    // Shares no substring with a seeded address, or a `hasText` row filter matches both
    // (`RUNBOOK.md` → Seed and fixtures).
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

      // ── Step 1: the permitted grant. Their own display name: left blank, it would overwrite the
      // column `beforeAll` derives the fixture from.
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

      // ── Step 3: the server refuses without the page's help. Withholding the control is a
      // courtesy, so the attack needs a row this manager may edit: a decoy carrying the tampered id.
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
        // The decoy's own id is a PERMITTED change, so an unapplied tamper passes every check below
        // without the attack happening. See `tamper`.
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
      // Deleting the decoy's login cascades to its profile and membership.
      if (decoyId) await db.auth.admin.deleteUser(decoyId);
    }
  });

  test("a manager can still promote someone whose leagues they all share", async ({
    page,
  }) => {
    // The control for the test above: a `mayWriteProfileOf` refusing every change would pass it
    // too. Both accounts are in every league, so containment holds.
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
      // Rendered here, unlike the row in the test above, with the manager option on it.
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

  // ── Server actions, reached by tampering a hidden id. As `Manager`, in BOTH leagues: each id
  // passes alone, and only requiring the SAME league refuses it.

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
      // Only the team is swapped: guarding the season alone passed this.
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

      // The refusal first: the guard redirects to the picker, and unlike the DB checks below this
      // WAITS, so it fails loudly rather than reading a write that has not landed yet.
      await expect(page).toHaveURL("/");

      // Nothing written, not even the player: the guard runs before the insert.
      const { data: players } = await db
        .from("players")
        .select("id")
        .eq("first_name", first);
      expect(players ?? []).toHaveLength(0);

      // The schema cannot refuse a cross-league roster row: the two foreign keys are independent.
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

  // ⚠️ No tamper test yet for `updateRosterPlayer`'s league guard, which resolves the league from
  // the row rather than the form. The gap is real; the fix is a test.

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

      // Your own row offers no Remove: for a league's sole manager it is the only way back in.
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
      // The original id is a PERMITTED removal, so an unapplied tamper removes the co-manager and
      // the "still a member" check passes without the attack. See `tamper`.
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

  // ── The RLS half: a staff session can reach PostgREST with no page, so the policies must refuse.
  // ⛔ `assertRefused` reads the row back: a refused UPDATE reports no error (`RUNBOOK.md` → Testing).
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
            // Step 1 is PERMITTED and asserted so: refused, step 2 would fail for that reason and
            // prove nothing.
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
        // 0009's "own profile update" names no columns, so without 0050 any account could make
        // itself a manager, or link itself to another league's captain.
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
            // ⚠️ Plus every account in no league: "manager write profiles" is `for all`, and
            // `contains_leagues_of` passes vacuously for one, so a brand-new account can be written.
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

            // ⛔ AND THE OFFICE STAYS OUT: office accounts are in no league, so only the tier hides
            // them. The size check stops an empty `league_office` read passing vacuously.
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
      // RLS must reach through a security_invoker view nested inside another, or a staged
      // league's stats are public.
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
      // 0051: a manager session could store an SVG in the PUBLIC logos bucket, around
      // `uploadTeamLogo`'s allowlist.
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
    // The control for the captain row.
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
    // No migration grants SELECT on these views, so ask as a browser does, not information_schema.
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

// The `next.config.ts` redirects keep bookmarked URLs alive, and nothing else in the suite would
// notice one deleted.
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
      // ⛔ Two explicit rules, never one `:rest*`: zero-or-more also matches bare `/schedule-builder`
      // and sends it to the games list instead of season setup (asserted at the end).
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

    // The League Office keeps `/manage/` and is no league, so a careless source pattern eats it.
    // Anonymous, its own guard sends it to /login: it reached the route.
    const office = await request.get("/manage/office", { maxRedirects: 0 });
    expect(locationOf(office).pathname).toBe("/login");

    // ⛔ The bare builder URL is a redirect PAGE, not a config rule (a rule can't pick the season);
    // driven signed in, since anonymous it bounces to /login.
    await signInAs(page, "Manager");
    await page.goto("/obhl/schedule-builder");
    await expect(page).toHaveURL(/\/obhl\/seasons\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("heading", { name: /Season setup/ }),
    ).toBeVisible();
  });
});

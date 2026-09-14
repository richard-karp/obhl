/** Setting up a season, creating a league, and working in a season nobody activated. */
/**
 * Path 7: Season setup.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/** Service-role client, for setting up and tearing down a throwaway season. */
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

async function goToActiveSeasonSetup(page: Page) {
  await page.goto("/obhl/seasons");
  await page
    .getByRole("row", { name: /Spring 2026/ })
    .getByRole("link", { name: "Setup" })
    .click();
  await expect(page).toHaveURL(/\/seasons\//);
}

test.describe("Path 7 — Season setup", () => {
  test("season setup page shows step chips and 6 enrolled teams", async ({
    page,
  }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");
    await goToActiveSeasonSetup(page);
    await expect(page.getByText("Season created")).toBeVisible();
    await expect(page.getByText("6 enrolled")).toBeVisible();
    await expect(page.locator("table tbody tr")).toHaveCount(6);
  });

  /**
   * Every season action, driven once, with its audit entry read back off the
   * page a manager actually opens.
   *
   * Both halves matter. `leagueOfEntity` (`src/lib/audit.ts`) returns null for
   * an `entity_type` it does not handle, and a null league is hidden by RLS
   * *and* filtered out of every league-scoped view — so an entry can be written
   * correctly and be invisible everywhere. A row count proves nothing about
   * that; the page does.
   *
   * Driven inside a season of its own, because the alternative is unenrolling
   * and reactivating the fixture every other spec is written against. The one
   * unavoidable exception is "Set active", which is per-league by definition —
   * it is done last and put back in `finally`.
   */
  test("every season action lands in this league's audit log", async ({
    page,
  }) => {
    const stamp = Date.now();
    const seasonName = `Audit Probe Season ${stamp}`;
    const teamName = `Audit Probe Team ${stamp}`;
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    const { data: wasActive } = await db
      .from("seasons")
      .select("id, name")
      .eq("league_id", league!.id)
      .eq("is_active", true)
      .single();

    let seasonId: string | null = null;
    let teamId: string | null = null;
    try {
      await signInAs(page, "Manager", "/obhl/dashboard");

      // ── create_season ────────────────────────────────────────────────────
      await page.goto("/obhl/seasons");
      await page.getByLabel("Name").fill(seasonName);
      await page.getByRole("button", { name: "Create season" }).click();
      // ⛔ Assert the DESTINATION, not the success message. `CreateSeasonForm`
      // renders `Season "<name>" created.` and, in a `useEffect` on the same
      // state, calls `router.push` to the new season's page — so waiting on
      // that message races the navigation that removes it. It lost that race
      // on CI run 34057995109: the season was created, the browser was already
      // on `Season setup — <name>`, and the message was simply gone. The
      // heading below is the same success, and it is the state that stays.
      await expect(
        page.getByRole("heading", { name: `Season setup — ${seasonName}` }),
      ).toBeVisible();

      const { data: made } = await db
        .from("seasons")
        .select("id")
        .eq("name", seasonName)
        .single();
      seasonId = made!.id as string;

      await page.goto("/obhl/audit");
      await expect(
        page.getByText(`Created season ${seasonName}`),
      ).toBeVisible();

      // ── create_team ──────────────────────────────────────────────────────
      await page.goto(`/obhl/seasons/${seasonId}`);
      await page.getByLabel("Team name").fill(teamName);
      await page.getByRole("button", { name: "Add team" }).click();
      await expect(page.getByText(`Added ${teamName}.`)).toBeVisible();
      const { data: madeTeam } = await db
        .from("teams")
        .select("id")
        .eq("name", teamName)
        .single();
      teamId = madeTeam!.id as string;

      await page.goto("/obhl/audit");
      await expect(page.getByText(`Added team ${teamName}`)).toBeVisible();

      // ── unenroll_team ────────────────────────────────────────────────────
      //
      // Destructive: the `season_teams` row is gone afterwards. The entry is
      // filed under the SEASON, which outlives it — a row that named the
      // enrollment would resolve to no league and disappear.
      await page.goto(`/obhl/seasons/${seasonId}`);
      await page
        .locator("table tbody tr")
        .filter({ hasText: teamName })
        .getByRole("button", { name: "Remove" })
        .click();
      await page.waitForLoadState("networkidle");

      await page.goto("/obhl/audit");
      await expect(
        page.getByText(`Removed ${teamName} from this season`),
      ).toBeVisible();

      // ── carry_forward_enrollment ─────────────────────────────────────────
      await page.goto(`/obhl/seasons/${seasonId}`);
      await page
        .getByRole("button", { name: "Same teams as last season" })
        .click();
      await page.waitForLoadState("networkidle");
      await expect(page.getByText("enrolled")).toBeVisible();

      // ── set_active_season ────────────────────────────────────────────────
      //
      // Last, because it takes the league's active season off whatever the rest
      // of the suite expects. Put back in `finally`.
      await page.goto("/obhl/seasons");
      await page
        .getByRole("row", { name: new RegExp(seasonName) })
        .getByRole("button", { name: "Set active" })
        .click();
      await page.waitForLoadState("networkidle");

      await page.goto("/obhl/audit");
      await expect(
        page.getByText(
          `Made ${seasonName} the active season (was ${wasActive!.name})`,
        ),
      ).toBeVisible();

      // …and every one of them named this league. That is the half the page
      // cannot show: an entry filed under no league renders as nothing at all,
      // which reads exactly like an entry that was never written.
      //
      // `carry_forward_enrollment` is only checked here. Its label carries no
      // unique text, so a match on the page could be a leftover from an earlier
      // run — and it reaches its league by the same `season` case as the four
      // above, which the page has already shown working.
      const { data: entries } = await db
        .from("audit_log")
        .select("action, league_id")
        .eq("entity_id", seasonId);
      const byAction = new Map(
        (entries ?? []).map((e) => [e.action, e.league_id]),
      );
      for (const action of [
        "create_season",
        "unenroll_team",
        "carry_forward_enrollment",
        "set_active_season",
      ]) {
        expect(byAction.has(action), `${action} wrote no audit entry`).toBe(
          true,
        );
        expect(
          byAction.get(action),
          `${action} was filed under no league`,
        ).toBe(league!.id);
      }
    } finally {
      // The two deletes are order-free — `season_teams` cascades from both
      // sides (`0003_membership.sql`). What is NOT order-free is the restore
      // below: by this point the probe season may be the active one, and a
      // partial unique index allows a league only one, so it has to be gone
      // before Spring 2026 can be made active again.
      if (seasonId) await db.from("seasons").delete().eq("id", seasonId);
      if (teamId) await db.from("teams").delete().eq("id", teamId);
      await db
        .from("seasons")
        .update({ is_active: true })
        .eq("id", wasActive!.id);
    }
  });
});

/**
 * The new-league page offers the rosters-only esportsdesk import, and nothing else.
 *
 * The spec stops at the form, so it never makes an outbound fetch to esportsdesk.
 */
test.describe("New league", () => {
  test("the new-league page offers a rosters-only import", async ({
    page,
  }) => {
    await signInAs(page, "Manager");
    await page.goto("/manage/leagues/new");

    await expect(page.getByLabel("esportsdesk league URL")).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview" })).toBeVisible();
    await expect(
      page.getByText(/imports the teams and players only/i),
    ).toBeVisible();
    await expect(page.getByText(/full migration/i)).toHaveCount(0);
  });
});

const SLUG = "imported-2028";
const LEAGUE = "Imported League 2028";
const SEASON = "Imported 2028";
const TEAM = "Import Otters";
const FIRST = "Imported";
const LAST = "Skater";

let leagueId = "";
let seasonId = "";
let teamId = "";
let playerId = "";

/** ids the OBHL assertions need, read rather than assumed. */
let obhlLeagueId = "";
let springId = "";
let fallId = "";
let harborSeasonId = "";

/**
 * Remove the fixture league and the global player it rostered.
 *
 * ⛔ THE DELETE IS ASSERTED. A league left behind here is still there when
 * 09-access runs, and it becomes that file's `LEAD_OUT` — every refusal there
 * would then aim at a league nobody is a member of, for the wrong reason.
 */
async function teardown() {
  const db = admin();
  // The league cascades to its seasons, teams, roster rows and memberships.
  const { error: leagueError } = await db
    .from("leagues")
    .delete()
    .eq("slug", SLUG);
  // `players` is global and hangs off no league, so it does not cascade.
  const { error: playerError } = await db
    .from("players")
    .delete()
    .eq("first_name", FIRST)
    .eq("last_name", LAST);
  if (leagueError || playerError) {
    throw new Error(
      `teardown failed: ${leagueError?.message ?? playerError?.message}`,
    );
  }
  const { data: left } = await db.from("leagues").select("id").eq("slug", SLUG);
  expect(left ?? [], `the ${SLUG} fixture league survived its teardown`).toHaveLength(0);
}

/**
 * Path 23: season gating — `is_active` means "what the public site shows", and
 * nothing else.
 *
 * Both importers create their season with `is_active: false`, so every manage
 * page keyed on the active season used to render "No active season" and stop:
 * you could import a league and then not edit the rosters you had just
 * imported. The manage tools now resolve a season of their own — `?season=`,
 * then a per-league cookie, then the active season, then the newest — and the
 * public site is left reading `is_active` alone.
 *
 * ⚠️ THE FIXTURE IS BUILT ON THE SERVICE-ROLE CLIENT, NOT THROUGH THE IMPORTER.
 * `runRosterOnlyImport` fetches an esportsdesk URL, and `03-season-setup`
 * already documents why no spec here makes that outbound call. What matters to
 * this file is the SHAPE the importer leaves behind — a league whose only
 * season has `is_active: false` — and that is written directly below. If the
 * importer ever starts activating what it creates, this fixture is what would
 * need revisiting, not these assertions.
 *
 * It runs late for the same reason `14-one-off-game` does: it creates a league
 * and a season, and the specs before it read the seeded ones.
 */
test.describe("Path 23 — season gating", () => {
  test.beforeAll(async () => {
    const db = admin();
    // Idempotent: a run that died before `afterAll` leaves the league behind, and
    // `leagues.slug` is unique.
    await teardown();

    const { data: league } = await db
      .from("leagues")
      // Not public. A league mid-import is exactly the staged case — manageable
      // before it is visible — and it keeps this fixture off the public picker.
      .insert({ name: LEAGUE, slug: SLUG, is_public: false })
      .select("id")
      .single();
    leagueId = league!.id;

    // ⛔ `is_active: false` is the whole point of the fixture. Do not "fix" this.
    const { data: season } = await db
      .from("seasons")
      .insert({
        league_id: leagueId,
        name: SEASON,
        starts_on: "2028-01-04",
        ends_on: "2028-06-30",
        is_active: false,
      })
      .select("id")
      .single();
    seasonId = season!.id;

    const { data: team } = await db
      .from("teams")
      .insert({
        league_id: leagueId,
        name: TEAM,
        slug: "import-otters",
        color: "#2f6f4f",
      })
      .select("id")
      .single();
    teamId = team!.id;
    await db
      .from("season_teams")
      .insert({ season_id: seasonId, team_id: teamId });

    const { data: player } = await db
      .from("players")
      .insert({ first_name: FIRST, last_name: LAST })
      .select("id")
      .single();
    playerId = player!.id;
    await db.from("team_players").insert({
      season_id: seasonId,
      team_id: teamId,
      player_id: playerId,
      jersey_number: 28,
      position: "F",
    });

    // Membership for the account these tests sign in as, and ONLY that account.
    // Granting it to every manager would put the single-league accounts that
    // `16-league-membership` derives its whole scenario from into two leagues.
    const { data: mgr } = await db
      .from("profiles")
      .select("id")
      .eq("display_name", "League Manager")
      .single();
    await db
      .from("profile_leagues")
      .upsert(
        { profile_id: mgr!.id, league_id: leagueId },
        { onConflict: "profile_id,league_id" },
      );

    // The seeded ids the OBHL half of this file compares against.
    const { data: obhl } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    obhlLeagueId = obhl!.id;
    const { data: seasons } = await db
      .from("seasons")
      .select("id, name")
      .eq("league_id", obhlLeagueId);
    springId = (seasons ?? []).find((s) => s.name === "Spring 2026")!.id;
    fallId = (seasons ?? []).find((s) => s.name === "Fall 2026")!.id;

    const { data: harbor } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "harbor")
      .single();
    const { data: harborSeason } = await db
      .from("seasons")
      .select("id")
      .eq("league_id", harbor!.id)
      .eq("is_active", true)
      .single();
    harborSeasonId = harborSeason!.id;

    // Was the test "the fixture is the shape these tests need". A fixture season
    // that IS active would make every assertion in the first test vacuous.
    const { data: shape } = await db
      .from("seasons")
      .select("is_active")
      .eq("id", seasonId)
      .single();
    expect(shape!.is_active, "the fixture season must be inactive").toBe(false);
    expect(springId, "no seeded Spring 2026").toBeTruthy();
    expect(fallId, "no seeded Fall 2026").toBeTruthy();
    expect(harborSeasonId, "no active Harbor season").toBeTruthy();
  });

  test.afterAll(teardown);

  test("a season nobody activated is still editable", async ({ page }) => {
    await signInAs(page, "Manager");
    // ⚠️ `/teams`, not `/manage/rosters`: the rosters index and the roster
    // editor page are both gone — the index IS the public teams list and the
    // editor is a section of the team's own page. What this test asks is
    // unchanged: can a manager work in a season nobody activated.
    await page.goto(`/${SLUG}/teams`);

    // The empty state this workstream deleted. Its presence here is the whole
    // bug: an imported league had nothing else to show.
    await expect(page.getByText("No active season")).toHaveCount(0);
    await expect(page.getByText("No seasons yet")).toHaveCount(0);
    await expect(page.getByLabel("Select season")).toHaveValue(seasonId);
    await expect(page.getByText(SEASON).first()).toBeVisible();

    await page.getByText(TEAM, { exact: true }).first().click();
    await expect(page).toHaveURL(/\/teams\//);
    const editor = page.getByRole("region", { name: "Manage roster" });
    await expect(editor).toBeVisible();
    const row = editor.getByRole("row", {
      name: new RegExp(`${FIRST} ${LAST}`),
    });
    await expect(row).toBeVisible();

    // Editable, not merely visible — a read-only page would satisfy everything
    // above and still leave the reported bug in place. ⛔ The control is in the
    // row's dialog now, and the badge it sets is back on the row, so the modal
    // has to be shut before the row is read: Radix marks everything behind it
    // `aria-hidden`.
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
  });

  test("switching season in manage does not move the public site", async ({
    page,
  }) => {
    await signInAs(page, "Manager");
    await page.goto("/obhl/teams");
    await expect(page.getByLabel("Select season")).toHaveValue(springId);

    // Fall 2026 exists, is enrolled, and is NOT active — the seed builds it for
    // exactly this kind of test.
    await page.getByLabel("Select season").selectOption(fallId);
    await expect(page.getByText("Fall 2026").first()).toBeVisible();

    // The choice is a cookie, so it follows you to the next staff surface
    // rather than living in one URL. `/schedule` is where `/manage/score` went.
    await page.goto("/obhl/schedule");
    await expect(page.getByLabel("Select season")).toHaveValue(fallId);

    // …and stops at what the PUBLIC sees. The standings page names the season
    // it is showing, and is keyed on `is_active` for everybody.
    await page.goto("/obhl/standings");
    await expect(page.getByText("Spring 2026")).toBeVisible();
    await expect(page.getByText("Fall 2026")).toHaveCount(0);
  });

  /**
   * ⛔ THE HALF THE MERGE PUT AT RISK. `/teams` and `/schedule` are public pages
   * that now carry the switcher for staff, so "the manager's season does not
   * move the public site" stopped being a claim about separate URLs and became a
   * claim about the same URL answering two viewers differently. A fresh context
   * is the only way to ask it: the assertions above all run as the manager, and
   * would pass whether or not an anonymous visitor were dragged along.
   */
  test("a manager's season choice does not follow a visitor", async ({
    page,
    browser,
  }) => {
    await signInAs(page, "Manager");
    await page.goto("/obhl/teams");
    await page.getByLabel("Select season").selectOption(fallId);
    await expect(page.getByText("Fall 2026").first()).toBeVisible();

    const anon = await browser.newContext();
    try {
      const visitor = await anon.newPage();
      await visitor.goto("/obhl/teams");
      await expect(visitor.getByText("Spring 2026").first()).toBeVisible();
      await expect(visitor.getByText("Fall 2026")).toHaveCount(0);
      // And no switcher at all — it is not a control a visitor is offered.
      await expect(visitor.getByLabel("Select season")).toHaveCount(0);
      await visitor.goto("/obhl/schedule");
      await expect(visitor.getByLabel("Select season")).toHaveCount(0);
    } finally {
      await anon.close();
    }
  });

  test("a season from another league is ignored, not fatal", async ({
    page,
    context,
  }) => {
    await signInAs(page, "Manager");

    // As a param.
    const res = await page.goto(`/obhl/teams?season=${harborSeasonId}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByLabel("Select season")).toHaveValue(springId);

    // And as a cookie, which is the case that actually happens: the key is
    // per-league, so this is a hand-forged one rather than anything the app
    // would write. A 404 here would lock a manager out of a league until they
    // found and cleared a cookie they cannot see.
    await context.addCookies([
      {
        name: `obhl_season_${obhlLeagueId}`,
        value: harborSeasonId,
        domain: "localhost",
        path: "/",
      },
    ]);
    const forged = await page.goto("/obhl/teams");
    expect(forged?.status()).toBe(200);
    await expect(page.getByLabel("Select season")).toHaveValue(springId);
  });
});

/**
 * Creating a league lives at `/manage/leagues/new`, outside `[league]`.
 *
 * This file exists because the move CHANGED who may reach the page, and the
 * assertion it replaces said the opposite. `16-league-membership` used to list
 * `/import` among the paths where "a manager of another league is refused" —
 * true while the page sat under `[league]` and guarded with
 * `requireLeagueManager`, and wrong now. The page guards with `requireManager()`,
 * matching the two importers behind it, which have always accepted any manager:
 * a league that does not exist yet has no membership to check against.
 *
 * ⚠️ The account that matters most here is `No-league mgr` — a `league_manager`
 * with no membership row and no office tier. Every other seeded manager is a
 * member of something (the office accounts implicitly, via `memberLeagueIds`),
 * so without it nothing would prove the guard is the role rather than the role
 * plus membership. It is also the realistic first user of an empty instance.
 *
 * ⛔ NOTHING HERE COMPLETES AN IMPORT. That needs an outbound fetch to
 * esportsdesk, which the suite does not do — see the note in `03-season-setup`.
 * The redirect into the new league, and the branches that report instead —
 * `problems[]` and the membership gate — live in `src/lib/actions/import.test.ts`,
 * which stubs the fetch and the database and tests the decisions.
 *
 * ⛔ DO NOT WIDEN THAT SENTENCE WITHOUT CHECKING IT. It once read "every branch
 * that reports instead of redirecting" while the two throwing exits had no
 * coverage at all — five mutants survived in them — and it was written in the
 * commit whose whole purpose was removing coverage overclaims.
 *
 * ⚠️ What is STILL covered by nothing, so that nobody reads the above as more
 * than it is: the real database writes and the real HTML parser. No test drives
 * either end to end.
 *
 * ⚠️ An earlier version of this comment claimed the redirect was "verified by
 * hand". It was not, by anyone, and writing that down is what kept the gap
 * invisible for three review rounds.
 */
const NEW_LEAGUE = "/manage/leagues/new";

const heading = (page: Page) =>
  page.getByRole("heading", { name: "Import from esportsdesk" });

test.describe("who may create a league", () => {
  for (const who of ["One-league mgr", "No-league mgr"] as const) {
    test(`${who} reaches the create page`, async ({ page }) => {
      await signInAs(page, who);
      await page.goto(NEW_LEAGUE);
      await expect(page).toHaveURL(NEW_LEAGUE);
      await expect(heading(page)).toBeVisible();
    });
  }

  test("a scorekeeper is refused", async ({ page }) => {
    await signInAs(page, "Scorekeeper");
    await page.goto(NEW_LEAGUE);
    // The picker — where every wrong-role refusal lands, being the one page that
    // needs no league.
    await expect(page).toHaveURL("/");
  });

  // No sign-in step: each test gets a fresh context, so this one is anonymous
  // by construction rather than by signing out.
  test("an anonymous visitor is sent to sign in rather than 404ing", async ({
    page,
  }) => {
    await page.goto(NEW_LEAGUE);
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("the page belongs to no league", () => {
  // The old `/:league/import` → `/manage/leagues/new` redirect (for every
  // league, since the page never belonged to any of them) is asserted in
  // `09-access.spec.ts`'s "every legacy URL still lands on its page".

  test("the root page offers it to a manager who belongs to nothing", async ({
    page,
  }) => {
    // ⛔ THE POINT OF THE WHOLE MOVE. This account is in no league, so the staff
    // row — drawn only for members — never appears for them anywhere. The root
    // page's link is their only way in, and on an instance with no leagues at
    // all it is the only way the first league can be created without SQL.
    await signInAs(page, "No-league mgr");
    await expect(page.getByRole("link", { name: "New league" })).toBeVisible();
  });
});

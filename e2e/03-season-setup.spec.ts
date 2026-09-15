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

  // Every season action, its audit entry read off the page (`RUNBOOK.md` → Access control → Traps),
  // in a season of its own; "Set active" is per-league, so it runs last and is put back.
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
      // ⛔ Assert the DESTINATION, not the success message: `CreateSeasonForm` pushes to the new
      // season's page on the same state, so the message races the navigation that removes it.
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

      // ── unenroll_team: filed under the SEASON, which outlives the deleted `season_teams` row; a
      // row naming the enrollment would resolve to no league.
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

      // ── set_active_season, last: it moves the league's active season. Put back in `finally`.
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

      // …and every one named this league, the half the page cannot show. `carry_forward_enrollment`
      // is checked only here: its label carries no unique text.
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
      // The deletes are order-free (`season_teams` cascades both ways). The restore is not: one active
      // season per league, so the probe season goes before Spring 2026 is reactivated.
      if (seasonId) await db.from("seasons").delete().eq("id", seasonId);
      if (teamId) await db.from("teams").delete().eq("id", teamId);
      await db
        .from("seasons")
        .update({ is_active: true })
        .eq("id", wasActive!.id);
    }
  });
});

// Stops at the form, so it never makes an outbound fetch to esportsdesk.
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

// ⛔ The delete is asserted: a league left behind can become `09-access`'s `LEAD_OUT`, aiming every
// refusal there at a league nobody belongs to.
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

// `is_active` means what the public site shows, nothing else. ⚠️ The fixture is written directly, not
// by the importer (no outbound fetch): what matters is a league whose only season is inactive.
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

    // Membership for this account ONLY: granting it to every manager would put `09-access`'s
    // single-league accounts in two leagues.
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

    // A fixture season that IS active would make every assertion in the first test vacuous.
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
    // ⚠️ `/teams`, not `/manage/rosters`: the rosters index is the public teams list now.
    await page.goto(`/${SLUG}/teams`);

    // "No active season" is the bug: an imported league had nothing else to show.
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

    // Editable, not merely visible. ⛔ Shut the dialog before reading the row's badge: Radix marks
    // everything behind a modal `aria-hidden`.
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

    // The choice is a cookie, so it follows you to the next staff surface.
    await page.goto("/obhl/schedule");
    await expect(page.getByLabel("Select season")).toHaveValue(fallId);

    // …and stops at what the PUBLIC sees. The standings page names the season
    // it is showing, and is keyed on `is_active` for everybody.
    await page.goto("/obhl/standings");
    await expect(page.getByText("Spring 2026")).toBeVisible();
    await expect(page.getByText("Fall 2026")).toHaveCount(0);
  });

  // ⛔ `/teams` and `/schedule` answer staff and visitors at one URL, so only a fresh context can show
  // that the manager's season does not follow a visitor.
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

    // As a hand-forged cookie, the case that happens: a 404 would lock a manager out of a league until
    // they cleared a cookie they cannot see.
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

// `requireManager()`: a league not yet created has no membership, and `No-league mgr` proves the role
// alone suffices. ⛔ Nothing here completes an import; its unit tests stub it (`RUNBOOK.md` → Importer).
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
  // The old `/:league/import` redirect is asserted in `09-access.spec.ts`'s legacy URL test.

  test("the root page offers it to a manager who belongs to nothing", async ({
    page,
  }) => {
    // ⛔ THE POINT OF THE MOVE: in no league, this account never gets the staff row, so the root page's
    // link is its only way in, and on an empty instance the only way to a league without SQL.
    await signInAs(page, "No-league mgr");
    await expect(page.getByRole("link", { name: "New league" })).toBeVisible();
  });
});

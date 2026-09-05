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
 * `runRosterOnlyImport` fetches an esportsdesk URL, and `17-roster-import`
 * already documents why no spec here makes that outbound call. What matters to
 * this file is the SHAPE the importer leaves behind — a league whose only
 * season has `is_active: false` — and that is written directly below. If the
 * importer ever starts activating what it creates, this fixture is what would
 * need revisiting, not these assertions.
 *
 * It runs late for the same reason `14-one-off-game` does: it creates a league
 * and a season, and the specs before it read the seeded ones.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/** Service-role client, for building and tearing down the fixture. */
function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

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

async function signedInAsManager(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Manager" }).click();
  // Sign-in lands on the league picker — there is no league-agnostic dashboard.
  await page.waitForURL("/");
}

/** Remove the fixture league and the global player it rostered. */
async function teardown() {
  const db = admin();
  // The league cascades to its seasons, teams, roster rows and memberships.
  await db.from("leagues").delete().eq("slug", SLUG);
  // `players` is global and hangs off no league, so it does not cascade.
  await db.from("players").delete().eq("first_name", FIRST).eq("last_name", LAST);
}

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
    .insert({ league_id: leagueId, name: TEAM, slug: "import-otters", color: "#2f6f4f" })
    .select("id")
    .single();
  teamId = team!.id;
  await db.from("season_teams").insert({ season_id: seasonId, team_id: teamId });

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
    .upsert({ profile_id: mgr!.id, league_id: leagueId }, { onConflict: "profile_id,league_id" });

  // The seeded ids the OBHL half of this file compares against.
  const { data: obhl } = await db.from("leagues").select("id").eq("slug", "obhl").single();
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
});

test.afterAll(teardown);

test.describe("Path 23 — season gating", () => {
  test("the fixture is the shape these tests need", async () => {
    // One clear failure if the setup above drifts, rather than a handful of
    // confusing ones below. In particular: a fixture season that IS active
    // would make every assertion in the first test vacuous.
    const { data } = await admin()
      .from("seasons")
      .select("is_active")
      .eq("id", seasonId)
      .single();
    expect(data!.is_active).toBe(false);
    expect(springId).toBeTruthy();
    expect(fallId).toBeTruthy();
    expect(harborSeasonId).toBeTruthy();
  });

  test("a season nobody activated is still editable", async ({ page }) => {
    await signedInAsManager(page);
    await page.goto(`/${SLUG}/manage/rosters`);

    // The empty state this workstream deleted. Its presence here is the whole
    // bug: an imported league had nothing else to show.
    await expect(page.getByText("No active season")).toHaveCount(0);
    await expect(page.getByLabel("Select season")).toHaveValue(seasonId);
    await expect(page.getByText(`Pick a team to manage its ${SEASON} roster.`)).toBeVisible();

    await page.goto(`/${SLUG}/manage/rosters/${teamId}`);
    await expect(page.getByRole("heading", { name: `${TEAM} — Roster` })).toBeVisible();
    const row = page.getByRole("row", { name: new RegExp(`${FIRST} ${LAST}`) });
    await expect(row).toBeVisible();

    // Editable, not merely visible — a read-only page would satisfy everything
    // above and still leave the reported bug in place.
    await row.getByRole("button", { name: "Suspend" }).click();
    await expect(
      row.locator('[data-slot="badge"]').filter({ hasText: "SUSP" }),
    ).toBeVisible();
  });

  test("switching season in manage does not move the public site", async ({
    page,
  }) => {
    await signedInAsManager(page);
    await page.goto("/obhl/manage/rosters");
    await expect(page.getByLabel("Select season")).toHaveValue(springId);

    // Fall 2026 exists, is enrolled, and is NOT active — the seed builds it for
    // exactly this kind of test.
    await page.getByLabel("Select season").selectOption(fallId);
    await expect(page.getByText("Pick a team to manage its Fall 2026 roster.")).toBeVisible();

    // The choice is a cookie, so it follows you to the next manage page rather
    // than living in one URL.
    await page.goto("/obhl/manage/score");
    await expect(page.getByLabel("Select season")).toHaveValue(fallId);

    // …and stops at the manage tools. The public standings page names the
    // season it is showing, so this reads which one the public site resolved.
    await page.goto("/obhl/standings");
    await expect(page.getByText("Spring 2026")).toBeVisible();
    await expect(page.getByText("Fall 2026")).toHaveCount(0);
  });

  test("?season= scopes one page without disturbing the rest", async ({ page }) => {
    await signedInAsManager(page);
    await page.goto(`/obhl/manage/rosters?season=${fallId}`);
    await expect(page.getByLabel("Select season")).toHaveValue(fallId);

    // The param is not sticky — only the switcher writes the cookie.
    await page.goto("/obhl/manage/rosters");
    await expect(page.getByLabel("Select season")).toHaveValue(springId);
  });

  test("a season from another league is ignored, not fatal", async ({
    page,
    context,
  }) => {
    await signedInAsManager(page);

    // As a param.
    const res = await page.goto(`/obhl/manage/rosters?season=${harborSeasonId}`);
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
    const forged = await page.goto("/obhl/manage/rosters");
    expect(forged?.status()).toBe(200);
    await expect(page.getByLabel("Select season")).toHaveValue(springId);
  });
});

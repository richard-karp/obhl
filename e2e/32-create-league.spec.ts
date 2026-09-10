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
 * esportsdesk, which the suite does not do — see the note in `17-roster-import`.
 * The redirect into the new league, and the branches that report instead —
 * `problems[]`, `notes[]`, the membership gate, and both throwing exits — live
 * in `src/lib/actions/import.test.ts`, which stubs the fetch and the database
 * and tests the decisions.
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
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const NEW_LEAGUE = "/manage/leagues/new";

/**
 * `exact` is defensive rather than required: Playwright's `name` is a
 * case-insensitive SUBSTRING match, so ambiguity needs one label to contain
 * another, and none of these does. ⚠️ An earlier version of this comment said
 * "No-league mgr" and "One-league mgr" both contain "mgr" — true, and not how
 * the matcher works. Keep the flag; a shortened label later would need it.
 */
async function signInAs(page: Page, label: string) {
  await page.goto("/login");
  await page.getByRole("button", { name: label, exact: true }).click();
  // Scorekeeper labels land on `/manage/tonight`; everyone else on the picker.
  await page.waitForURL(
    /scorer|scorekeeper/i.test(label) ? "/manage/tonight" : "/",
  );
}

const heading = (page: Page) =>
  page.getByRole("heading", { name: "Import from esportsdesk" });

test.describe("who may create a league", () => {
  for (const who of ["Manager", "One-league mgr", "No-league mgr"]) {
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
  test("the old per-league URL redirects here", async ({ page }) => {
    await signInAs(page, "Manager");
    // `/:league/import` → `/manage/leagues/new`, for every league, since the
    // page never belonged to any of them.
    await page.goto("/obhl/import");
    await expect(page).toHaveURL(NEW_LEAGUE);
    await expect(heading(page)).toBeVisible();
  });

  test("the League Office is not swallowed by that redirect", async ({
    page,
  }) => {
    // `/:league/import` would match `/manage/import` with `:league` = "manage",
    // which is why the destination has three segments. This is the neighbouring
    // route that proves nothing under `/manage/` got caught up in it.
    await signInAs(page, "Commissioner");
    await page.goto("/manage/office");
    await expect(page).toHaveURL("/manage/office");
    await expect(
      page.getByRole("heading", { name: "League Office" }),
    ).toBeVisible();
  });

  test("a manager sees the link in the staff row, a scorekeeper does not", async ({
    page,
  }) => {
    const staffRow = page.getByRole("navigation", { name: "Staff tools" });

    await signInAs(page, "Manager");
    await page.goto("/obhl");
    await expect(
      staffRow.getByRole("link", { name: "New league" }),
    ).toBeVisible();
    // And it no longer offers the old league-relative one.
    await expect(
      staffRow.getByRole("link", { name: "Import", exact: true }),
    ).toHaveCount(0);

    await signInAs(page, "Scorekeeper");
    await page.goto("/obhl");
    await expect(
      staffRow.getByRole("link", { name: "New league" }),
    ).toHaveCount(0);
  });

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

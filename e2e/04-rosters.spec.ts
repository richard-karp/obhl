/**
 * Path 9: Rosters — add player, set captain, suspend, remove, logo upload.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(
  page: Page,
  role: "Manager" | "Scorekeeper" | "Captain",
) {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  // Sign-in lands on the league picker — there is no league-agnostic dashboard
  // any more. Every caller below expects to be inside a league's manage tools.
  await page.waitForURL("/");
  await page.goto("/obhl/dashboard");
}

test.describe("Path 9 — Roster editor", () => {
  test.beforeEach(async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/obhl/teams");
    await page.getByText("Sharks").click();
    await expect(page).toHaveURL(/\/teams\//);
    // The roster editor is a tab on the team page now, not a page of
    // its own behind a uuid.
    await page.getByRole("tab", { name: "Manage" }).click();
    await page.waitForURL(/\?tab=manage$/);
  });

  test("roster page shows 14 players with jersey numbers", async ({ page }) => {
    await expect(page.locator("table tbody tr")).toHaveCount(14);
    await expect(
      page.locator("table tbody tr").first().getByText("Goalie"),
    ).toBeVisible();
  });

  test("add a new player and they appear in the roster", async ({ page }) => {
    await page
      .getByPlaceholder("First name")
      .or(page.getByLabel("First name"))
      .fill("Testy");
    await page
      .getByPlaceholder("Last name")
      .or(page.getByLabel("Last name"))
      .fill("McTestface");

    await page.getByRole("button", { name: /add/i }).click();
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("cell", { name: "Testy McTestface" }),
    ).toBeVisible();
  });

  test("removing a player is visible in this league's audit log", async ({
    page,
  }) => {
    // The entry is written either way; the subject here is whether it can be
    // SEEN. `logAudit` resolves the league from the entity it names, and by the
    // time a removal logs, the roster row it names is gone — so the entry lands
    // under a null league, which RLS and every league-scoped view hide. That
    // also puts it beyond the revert its own `old_data` exists to serve.
    const first = `Auditee${Date.now()}`;
    await page
      .getByPlaceholder("First name")
      .or(page.getByLabel("First name"))
      .fill(first);
    await page
      .getByPlaceholder("Last name")
      .or(page.getByLabel("Last name"))
      .fill("Player");
    await page.getByRole("button", { name: /add/i }).click();
    await expect(
      page.getByRole("cell", { name: `${first} Player` }),
    ).toBeVisible();

    await page
      .locator("table tbody tr")
      .filter({ hasText: first })
      .getByRole("button", { name: "Remove" })
      .click();
    // Waits, and is the settle signal for the POST: the audit read below must
    // not fire while the delete is still in flight.
    await expect(
      page.getByRole("cell", { name: `${first} Player` }),
    ).toHaveCount(0);

    await page.goto("/obhl/audit");
    await expect(
      page.getByText(`Removed ${first} Player from roster`),
    ).toBeVisible();
  });

  /**
   * The regression that soft departures introduced.
   *
   * Removing a player who has dressed keeps their roster row and marks it
   * departed (0036), and `unique (season_id, team_id, player_id)` from 0003 is
   * deliberately non-partial — so a plain insert on the way back is rejected
   * with a bare 23505. The picker offers them, too, because the roster it
   * subtracts is filtered to active rows. Coming back is therefore the normal
   * way an operator undoes a removal, not an edge case.
   */
  test("a removed player can be added back to the same team", async ({
    page,
  }) => {
    const row = page.locator("table tbody tr").first();
    // The second cell: the table is #, Player, Position, Status, Manage.
    const name = (await row.locator("td").nth(1).innerText())
      .split("\n")[0]
      .trim();

    // Their position, so it can be put back. The add form is the same form
    // whether the person is new or returning, so it decides both position and
    // number — and its position default is F. Re-adding the Sharks' goalie
    // without setting it turns them into a forward and leaves the team with no
    // goalie at all, which is what broke e2e/13 the first time this ran.
    const POS_CODE: Record<string, string> = {
      Forward: "F",
      Defense: "D",
      Goalie: "G",
    };
    const position =
      POS_CODE[(await row.locator("td").nth(2).innerText()).trim()] ?? "F";

    await row.getByRole("button", { name: "Remove" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("cell", { name })).toHaveCount(0);

    await page
      .getByLabel("Existing person (optional)")
      .selectOption({ label: name });
    await page.getByLabel("Pos").selectOption(position);
    await page.getByRole("button", { name: /add/i }).click();
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("cell", { name })).toBeVisible();
    await expect(
      page.locator("table tbody tr").filter({ hasText: name }),
    ).toHaveCount(1);
  });

  test("toggle captain sets and removes C badge", async ({ page }) => {
    const row = page.locator("table tbody tr").nth(1);
    await row.getByRole("button", { name: "Make C" }).click();
    await page.waitForLoadState("networkidle");
    await expect(row.getByText("C").first()).toBeVisible();

    await row.getByRole("button", { name: "Unset C" }).click();
    await page.waitForLoadState("networkidle");
    await expect(row.getByText("Make C")).toBeVisible();
  });

  test("suspend a player shows SUSP badge, lift removes it", async ({
    page,
  }) => {
    const row = page.locator("table tbody tr").nth(2);
    await row.getByRole("button", { name: "Suspend" }).click();
    await page.waitForLoadState("networkidle");
    await expect(
      row.locator('[data-slot="badge"]').filter({ hasText: "SUSP" }),
    ).toBeVisible();

    await row.getByRole("button", { name: "Lift Susp." }).click();
    await page.waitForLoadState("networkidle");
    await expect(
      row.locator('[data-slot="badge"]').filter({ hasText: "SUSP" }),
    ).not.toBeVisible();
  });

  test("logo upload card is visible", async ({ page }) => {
    await expect(page.getByText("Team logo")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /upload|change/i }),
    ).toBeVisible();
  });
});

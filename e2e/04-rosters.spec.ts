/**
 * Path 9: Rosters — add player, set captain, suspend, remove, logo upload.
 */
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * The editor's own region, and its roster table.
 *
 * The team page shows the PUBLIC roster table first and the editable one inside
 * "Manage roster" below it, so an unscoped `table tbody tr` — or an unscoped
 * `getByRole("cell")` — reads the wrong table, or matches both and trips strict
 * mode. Scoping is what the Manage tab used to do for free.
 */
function manageRoster(page: Page) {
  return page.getByRole("region", { name: "Manage roster" });
}

function rosterRows(page: Page) {
  return manageRoster(page).locator("table tbody tr");
}

/**
 * Open a row's editor and return the dialog.
 *
 * ⛔ THE DIALOG IS A PORTAL — IT IS NOT INSIDE THE `<tr>`. Every control that
 * used to be scoped to the row (Make C, Suspend, the injury note, Transfer,
 * the name fields, `role="status"`) now renders at the end of the document,
 * so `row.getByRole(...)` finds nothing. Scope to this instead.
 */
async function openDialogFor(page: Page, row: Locator) {
  await row.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

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

/**
 * Path 9b — the public roster, in the three sections a hockey roster has.
 *
 * ⚠️ THE PUBLIC TABLE, NOT THE EDITOR. The team page renders both; these
 * assertions are deliberately unscoped by region because the headings belong
 * to the public half, above "Manage roster".
 */
test.describe("Path 9b — Forwards, Defence and Goalies", () => {
  test("the roster is split into three sections", async ({ page }) => {
    await page.goto("/obhl/teams/sharks");
    for (const name of ["Forwards", "Defence", "Goalies"]) {
      await expect(page.getByRole("heading", { name })).toBeVisible();
    }
  });

  test("goalies are listed even with no games played", async ({ page }) => {
    // ⛔ THE CASE PRODUCTION IS IN. `v_goalie_stats` is built only from FINAL
    // games, so a rostered goalie who has not played is absent from it — and
    // on the day this shipped that was EVERY goalie in both live leagues, 19
    // of 19, because no game had been scored yet. A Goalies section built from
    // that view alone would have been empty on every team page in the app.
    // Sharks' #8 has never played: the seed converts them from a forward and
    // they appear in no finalized game.
    const goalies = page
      .getByRole("region", { name: "Goalies" })
      .locator("tbody tr");
    await page.goto("/obhl/teams/sharks");
    await expect(goalies).toHaveCount(2);
    await expect(goalies.filter({ hasText: "8" })).toHaveCount(1);
  });

  test("a two-night league shows the night; a one-night league does not", async ({
    page,
  }) => {
    // OBHL declares Tue+Thu, so the column is meaningful and appears. Harbor
    // declares nothing and plays one weekday, so `hasMultipleNights` is false
    // and the column must not appear at all — a select with one option is a
    // control that can only restate what the season already says.
    await page.goto("/obhl/teams/sharks");
    await expect(
      page.getByRole("columnheader", { name: "Night" }).first(),
    ).toBeVisible();

    await page.goto("/harbor/teams/anchors");
    await expect(
      page.getByRole("columnheader", { name: "Night" }),
    ).toHaveCount(0);
  });
});

test.describe("Path 9 — Roster editor", () => {
  test.beforeEach(async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/obhl/teams");
    await page.getByText("Sharks").click();
    await expect(page).toHaveURL(/\/teams\//);
    // A manager just sees the editor. Waiting on its first row is the settle
    // signal every test below used to get from the tab click.
    await expect(rosterRows(page).first()).toBeVisible();
  });

  test("roster page shows 14 players with jersey numbers", async ({ page }) => {
    // Still 14 across the three section tables — the seed converts a forward
    // to a second goalie rather than adding a player, precisely so this does
    // not move.
    await expect(rosterRows(page)).toHaveCount(14);
    // ⚠️ POSITION IS A SECTION HEADING NOW, NOT A CELL. The first row is a
    // FORWARD, because Forwards come first; asserting "Goalie" on it tested
    // the old flat, jersey-ordered table.
    await expect(
      manageRoster(page).getByRole("heading", { name: "Goalies" }),
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
      manageRoster(page).getByRole("cell", { name: "Testy McTestface" }),
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
      manageRoster(page).getByRole("cell", { name: `${first} Player` }),
    ).toBeVisible();

    await rosterRows(page)
      .filter({ hasText: first })
      .getByRole("button", { name: "Remove" })
      .click();
    // Waits, and is the settle signal for the POST: the audit read below must
    // not fire while the delete is still in flight.
    await expect(
      manageRoster(page).getByRole("cell", { name: `${first} Player` }),
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
    // ⛔ THE SECTION SAYS THE POSITION NOW, SO THE TEST ASKS THE SECTION.
    // This used to read `td` by hard-coded INDEX — cell 1 for the name, cell 2
    // for the position — against a flat table of #, Player, Position, Status,
    // Manage. Both indices moved when the row lost its Status and Manage
    // columns and gained a Night one, and the position left the row entirely.
    // ⛔ DEFENCE, AND NOT THE FIRST FORWARD. This test REMOVES its subject and
    // re-adds them through the add form, which carries no jersey number and no
    // captaincy — so whoever it picks comes back as an unnumbered non-captain.
    // With Forwards first, that was Sharks #6: the seeded CAPTAIN, and the
    // account `13-goalie`'s Path 21 signs in as. It passed here and broke that
    // spec three files later. Defence carries no captain in the seed.
    const defence = manageRoster(page)
      .getByRole("region", { name: "Manage Defence" })
      .locator("tbody tr");

    // ⛔ BADGES STRIPPED EXPLICITLY, NOT BY TAKING THE FIRST LINE. Captain,
    // rookie, suspended and injury render as inline badges inside the name
    // cell with no newline before them, so `.split("\n")[0]` — what this used
    // to do — returned "Taylor GauthierC" for any row carrying one. It only
    // ever worked because the row it happened to read, the jersey-1 goalie at
    // the top of a flat numeric table, had no badges.
    const rowName = async (r: Locator) => {
      const cell = r.locator("td").nth(1);
      const badges = await cell.locator('[data-slot="badge"]').allInnerTexts();
      let n = (await cell.innerText()).trim();
      for (const b of badges) n = n.replace(b, "").trim();
      return n;
    };

    // ⛔ AND THE SUBJECT'S NAME MUST BE UNIQUE, WHICH IS NOT FREE. The seed
    // builds names by modular arithmetic over two short arrays, so it produces
    // genuine duplicates — two different people called "Parker Bouchard". The
    // picker offers both with nothing to tell them apart, so re-adding could
    // put the OTHER one on the team and still satisfy every assertion below.
    //
    // Probed BEFORE the removal, which is what makes it decidable: somebody
    // already on this team is not offered by the picker, so any option
    // matching their name is a different person. Zero options means the name
    // is theirs alone.
    const picker = page.getByLabel("Existing person (optional)");
    let row: Locator | null = null;
    let name = "";
    for (let i = 0; i < (await defence.count()); i++) {
      const candidate = defence.nth(i);
      const candidateName = await rowName(candidate);
      await picker.fill(candidateName);
      const clashes = await page
        .getByRole("option", { name: candidateName })
        .count();
      if (clashes === 0) {
        row = candidate;
        name = candidateName;
        break;
      }
    }
    await picker.fill("");
    if (!row) {
      throw new Error(
        "Every seeded defender shares a name with somebody else — check supabase/seed.sql's name arrays.",
      );
    }
    const position = "D";

    await row.getByRole("button", { name: "Remove" }).click();
    await page.waitForLoadState("networkidle");
    await expect(manageRoster(page).getByRole("cell", { name })).toHaveCount(0);

    // ⛔ NOT `selectOption`. The picker is a filtered combobox now, not a
    // `<select>` — `players` is global and unfiltered here, so the list grows
    // with the instance and scrolling it was the thing being replaced. Type
    // enough of the name to narrow the list, then click the option.
    //
    // There is deliberately NO hidden `<select>` kept behind it to make the old
    // line keep working: two fields that can disagree about who is selected,
    // one of them invisible, is worse than a test that had to be rewritten.
    await page.getByLabel("Existing person (optional)").fill(name);
    await page.getByRole("option", { name }).click();
    await page.getByLabel("Pos").selectOption(position);
    await page.getByRole("button", { name: /add/i }).click();
    await page.waitForLoadState("networkidle");

    await expect(manageRoster(page).getByRole("cell", { name })).toBeVisible();
    await expect(rosterRows(page).filter({ hasText: name })).toHaveCount(1);
  });

  test("toggle captain sets and removes C badge", async ({ page }) => {
    // ⚠️ THE BADGE IS STILL ON THE ROW; THE BUTTON MOVED INTO THE DIALOG. The
    // row is what a manager reads, so the assertion stays there — only the
    // control that changes it is a click deeper.
    const row = rosterRows(page).nth(1);
    let dialog = await openDialogFor(page, row);
    await dialog.getByRole("button", { name: "Make captain" }).click();
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Escape");
    await expect(
      row.locator('[data-slot="badge"]').filter({ hasText: "C" }).first(),
    ).toBeVisible();

    dialog = await openDialogFor(page, row);
    await dialog.getByRole("button", { name: "Captain ✓" }).click();
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Escape");
    await expect(
      row.locator('[data-slot="badge"]').filter({ hasText: /^C$/ }),
    ).toHaveCount(0);
  });

  test("suspend a player shows SUSP badge, lift removes it", async ({
    page,
  }) => {
    const row = rosterRows(page).nth(2);
    let dialog = await openDialogFor(page, row);
    await dialog.getByRole("button", { name: "Suspend" }).click();
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Escape");
    await expect(
      row.locator('[data-slot="badge"]').filter({ hasText: "SUSP" }),
    ).toBeVisible();

    dialog = await openDialogFor(page, row);
    await dialog.getByRole("button", { name: "Suspended ✓" }).click();
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Escape");
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

  /**
   * ⛔ THE GUARD ON THE DECISION THIS PAGE IS BUILT ON. There was a Manage tab
   * and a `?tab=manage` here, and both were removed on the call that a manager
   * should see their page and be able to edit it rather than navigate to a
   * second view of the team they are already looking at.
   *
   * They are worth a test because the two of them together caused three
   * separate bugs — a blank panel on the way back out, a blank panel on
   * arrow-key focus, and an editor that rendered its four admin queries whether
   * or not anyone opened it. Anything that reintroduces a mode here turns this
   * red.
   */
  test("the editor is on the page, behind no tab and no query parameter", async ({
    page,
  }) => {
    await expect(page.getByRole("tab", { name: "Manage" })).toHaveCount(0);
    expect(new URL(page.url()).search).toBe("");
    await expect(manageRoster(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove" }).first(),
    ).toBeVisible();

    // The two remaining tabs are ordinary client-side tabs over public content:
    // switching away unmounts the editor with the rest of the panel, switching
    // back brings it straight home, and the URL never moves.
    await page.getByRole("tab", { name: "Schedule" }).click();
    await expect(manageRoster(page)).toHaveCount(0);
    await page.getByRole("tab", { name: "Roster & Stats" }).click();
    await expect(manageRoster(page)).toBeVisible();
    expect(new URL(page.url()).search).toBe("");
  });
});

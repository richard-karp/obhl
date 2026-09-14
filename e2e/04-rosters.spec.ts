/** Rosters: the public team page, the editor and its audit trail, revert, and duplicates. */
/**
 * Path 9: Rosters — add player, set captain, suspend, remove, logo upload.
 */
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/** The same service-role client the other specs build — see `05-scoring-night`. */
function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

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

/**
 * Suspend whoever is in `row`, through their editor.
 *
 * ⛔ THE CONTROL MOVED INTO A DIALOG, WHICH IS A PORTAL. It is no longer inside
 * the `<tr>`, and while it is open Radix marks the rest of the document
 * `aria-hidden` — so it is opened, used, and shut before anything else on the
 * page is touched. What these tests are about is the AUDIT ENTRY the action
 * writes, which is unchanged.
 */
async function suspendVia(page: Page, row: Locator) {
  await row.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^Suspend$|^Suspended ✓$/ }).click();
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
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

/**
 * Path 9b — the public roster, in the three sections a hockey roster has.
 *
 * ⚠️ THE PUBLIC TABLE, NOT THE EDITOR. The team page renders both; these
 * assertions are deliberately unscoped by region because the headings belong
 * to the public half, above "Manage roster".
 */
test.describe("Path 9b — Forwards, Defence and Goalies", () => {
  test("goalies are listed even with no games played", async ({ page }) => {
    // ⛔ THE CASE PRODUCTION IS IN. `v_goalie_stats` is built only from FINAL
    // games, so a rostered goalie who has not played is absent from it — and
    // on the day this shipped that was EVERY goalie in both live leagues, 19
    // of 19, because no game had been scored yet. A Goalies section built from
    // that view alone would have been empty on every team page in the app.
    // Sharks' #8 has never played: the seed converts them from a forward and
    // dresses only the starting goalie, so they appear in no finalized game.
    const section = page.getByRole("region", { name: "Goalies" });
    const goalies = section.locator("tbody tr");
    await page.goto("/obhl/teams/sharks");
    await expect(goalies).toHaveCount(2);

    // ⚠️ THE JERSEY CELL, NOT THE ROW. `hasText: "8"` matched anywhere in the
    // row — a GA, GAA or GP containing an 8 would have satisfied it just as
    // well. The number is the first cell.
    const backup = goalies.filter({
      has: page.locator("td:first-child", { hasText: /^8$/ }),
    });
    await expect(backup).toHaveCount(1);

    // ⛔ AND THE PREMISE ITSELF, WHICH THIS TEST DID NOT CHECK. Its name has
    // always been "even with no games played", but the two assertions above
    // hold whether or not #8 has played — and they were green for a while when
    // #8 WAS dressed in all three finals. A test that cannot notice its own
    // premise breaking is the shape this file exists to guard against.
    //
    // ⚠️ THE GP COLUMN IS FOUND BY ITS HEADER, NOT BY INDEX. A wrong index
    // lands on a neighbouring zero and passes anyway. The original reason was
    // that Night was a column on OBHL and absent on Harbor, so the index
    // differed BY LEAGUE; the night is a pill in the name cell now and the two
    // leagues agree, but a hard-coded position is still one refactor away from
    // passing for the wrong reason.
    const headers = await section.locator("thead th").allInnerTexts();
    const gp = headers.findIndex((h) => h.trim() === "GP");
    expect(gp, "no GP column in the Goalies section").toBeGreaterThan(-1);
    await expect(backup.locator("td").nth(gp)).toHaveText("0");
  });
});

test.describe("Path 9 — Roster editor", () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto("/obhl/teams");
    await page.getByText("Sharks").click();
    await expect(page).toHaveURL(/\/teams\//);
    // A manager just sees the editor. Waiting on its first row is the settle
    // signal every test below used to get from the tab click.
    await expect(rosterRows(page).first()).toBeVisible();
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

    // ── Folded in from the former audit-log spec: both directions are
    // audited, under this league. `logAudit` resolves the league from the
    // entity, and an entry filed under none is hidden from every view that
    // would show it.
    await page.goto("/obhl/audit");
    await expect(page.getByText(/Made .+ captain/).first()).toBeVisible();
    await expect(page.getByText(/Removed captain from /).first()).toBeVisible();
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    const { data: entries } = await db
      .from("audit_log")
      .select("league_id")
      .eq("action", "toggle_captain")
      .order("created_at", { ascending: false })
      .limit(2);
    expect(entries).toHaveLength(2);
    for (const e of entries!) expect(e.league_id).toBe(league!.id);
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

    // ── Folded in from the former audit-log spec: both writes are audited,
    // under this league.
    await page.goto("/obhl/audit");
    await expect(
      page.getByText(/Updated is suspended for /).first(),
    ).toBeVisible();
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    const { data: entries } = await db
      .from("audit_log")
      .select("league_id")
      .eq("action", "update_player_status")
      .order("created_at", { ascending: false })
      .limit(2);
    expect(entries).toHaveLength(2);
    for (const e of entries!) expect(e.league_id).toBe(league!.id);
  });
});

/**
 * Path 12: Audit log — view logged actions and session-based revert.
 */
test.describe("Path 12 — Audit revert", () => {
  test("revert button is present when session entries exist", async ({
    page,
  }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");

    // Create a revertible action
    await page.goto("/obhl/teams");
    await page.getByText("Wolves").click();
    await expect(page).toHaveURL(/\/teams\//);
    // The editing forms are simply on the page for a manager now — no tab to
    // open and no `?tab=` to wait for.
    await suspendVia(page, rosterRows(page).nth(2));

    await page.goto("/obhl/audit");
    const revertBtn = page
      .getByRole("button", { name: /revert selected/i })
      .first();
    await expect(revertBtn).toBeVisible();
    await revertBtn.click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/reverted successfully/i)).toBeVisible();
  });
});

/** Duplicate merge review. */
test.describe("Merge duplicates", () => {
  test("duplicates page loads and is scoped to this league", async ({
    page,
  }) => {
    await signInAs(page, "Manager");
    await page.goto("/obhl/people/duplicates");

    await expect(
      page.getByRole("heading", { name: /possible duplicates/i }),
    ).toBeVisible();
    // Every listed name must belong to THIS league. The seed builds names from
    // arrays, so real clusters may or may not exist — assert the scope, not a
    // count, or this test breaks whenever the seed's name arithmetic changes.
    await expect(page.getByText("Anchors")).toHaveCount(0);
  });
});

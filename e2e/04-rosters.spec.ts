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

// The team page shows the PUBLIC roster table first, so an unscoped `tbody tr` or `cell` reads the
// wrong table or trips strict mode.
function manageRoster(page: Page) {
  return page.getByRole("region", { name: "Manage roster" });
}

function rosterRows(page: Page) {
  return manageRoster(page).locator("table tbody tr");
}

// ⛔ The dialog is a portal, not inside the `<tr>`: `row.getByRole(...)` finds nothing, so scope to it.
async function openDialogFor(page: Page, row: Locator) {
  await row.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

// ⛔ The dialog is a portal, and while it is open Radix marks the rest of the document `aria-hidden`:
// open, use and shut it before touching the page.
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

// ⚠️ The PUBLIC table, not the editor: these headings are unscoped because they belong to the public
// half, above "Manage roster".
test.describe("Path 9b — Forwards, Defence and Goalies", () => {
  test("goalies are listed even with no games played", async ({ page }) => {
    // ⛔ `v_goalie_stats` holds only FINAL games, so a Goalies section built from it alone is empty for
    // goalies who have not played. Sharks' #8 never has: the seed dresses only the starter.
    const section = page.getByRole("region", { name: "Goalies" });
    const goalies = section.locator("tbody tr");
    await page.goto("/obhl/teams/sharks");
    await expect(goalies).toHaveCount(2);

    // ⚠️ The jersey CELL, not the row: `hasText: "8"` on the row matches a GA, GAA or GP containing 8.
    const backup = goalies.filter({
      has: page.locator("td:first-child", { hasText: /^8$/ }),
    });
    await expect(backup).toHaveCount(1);

    // ⛔ And the premise: the assertions above hold whether or not #8 has played. ⚠️ GP is found by its
    // header, not an index, since a wrong index lands on a neighbouring zero and passes.
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
    // A manager just sees the editor; its first row is the settle signal.
    await expect(rosterRows(page).first()).toBeVisible();
  });

  test("removing a player is visible in this league's audit log", async ({
    page,
  }) => {
    // Whether the entry can be SEEN: by the time a removal logs, its roster row is gone, so a league
    // resolved from it is null and hidden (`RUNBOOK.md` → Access control → Traps).
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

    const since = new Date().toISOString();
    await rosterRows(page)
      .filter({ hasText: first })
      .getByRole("button", { name: "Remove" })
      .click();
    // Waits, and is the settle signal for the POST: the audit read below must
    // not fire while the delete is still in flight.
    await expect(
      manageRoster(page).getByRole("cell", { name: `${first} Player` }),
    ).toHaveCount(0);

    // `remove_player` is audited with `void logAudit` — the action returns before the
    // row exists, so wait for it rather than racing the audit page.
    await expect
      .poll(
        async () => {
          const { count } = await admin()
            .from("audit_log")
            .select("id", { count: "exact", head: true })
            .eq("action", "remove_player")
            .gte("created_at", since);
          return count ?? 0;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);

    await page.goto("/obhl/audit");
    await expect(
      page.getByText(`Removed ${first} Player from roster`),
    ).toBeVisible();
  });

  test("toggle captain sets and removes C badge", async ({ page }) => {
    // ⚠️ The badge is on the row, the button in the dialog: the assertion stays on the row a manager reads.
    const row = rosterRows(page).nth(1);
    const since = new Date().toISOString();
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

    // Both directions are audited under this league. `toggle_captain` uses `void logAudit`, which
    // returns before the row exists, so wait for it.
    await expect
      .poll(
        async () => {
          const { count } = await admin()
            .from("audit_log")
            .select("id", { count: "exact", head: true })
            .eq("action", "toggle_captain")
            .gte("created_at", since);
          return count ?? 0;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(2);

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
    const since = new Date().toISOString();
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

    // Both writes are audited under this league. `update_player_status` uses `void logAudit`, which
    // returns before the row exists, so wait for it.
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
      .toBeGreaterThanOrEqual(2);

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

test.describe("Path 12 — Audit revert", () => {
  test("revert button is present when session entries exist", async ({
    page,
  }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");

    // Create a revertible action
    await page.goto("/obhl/teams");
    await page.getByText("Wolves").click();
    await expect(page).toHaveURL(/\/teams\//);
    const since = new Date().toISOString();
    await suspendVia(page, rosterRows(page).nth(2));

    // `void logAudit` returns before the row exists, and the revert button appears only for session
    // entries the page can already see, so wait.
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

test.describe("Merge duplicates", () => {
  test("duplicates page loads and is scoped to this league", async ({
    page,
  }) => {
    await signInAs(page, "Manager");
    await page.goto("/obhl/people/duplicates");

    await expect(
      page.getByRole("heading", { name: /possible duplicates/i }),
    ).toBeVisible();
    // Every listed name must be THIS league's. Assert the scope, not a count: whether clusters exist
    // depends on the seed's name arithmetic.
    await expect(page.getByText("Anchors")).toHaveCount(0);
  });
});

/**
 * Path 14: People & Roles — view staff listing and form structure.
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signedInAs(page: Page, role: "Manager" | "Scorekeeper" | "Captain") {
  await page.goto("/login");
  await page.getByRole("button", { name: role }).click();
  // Sign-in lands on the league picker — there is no league-agnostic dashboard
  // any more. Every caller below expects to be inside a league's manage tools.
  await page.waitForURL("/");
  await page.goto("/obhl/manage/dashboard");
}

test.describe("Path 14 — People & Roles", () => {
  test.beforeEach(async ({ page }) => {
    await signedInAs(page, "Manager");
    await page.goto("/obhl/manage/people");
  });

  test("renders staff table with seeded accounts and role labels", async ({
    page,
  }) => {
    await expect(page.getByText("manager@obhl.test")).toBeVisible();
    await expect(page.getByText("scorekeeper@obhl.test")).toBeVisible();
    await expect(page.getByText("captain@obhl.test")).toBeVisible();
    await expect(page.getByText("Manager").first()).toBeVisible();
    await expect(page.getByText("Scorekeeper").first()).toBeVisible();
    await expect(page.getByText("Captain").first()).toBeVisible();
  });

  test("Add a staff account form is present with role selector", async ({
    page,
  }) => {
    await expect(page.getByText("Add a staff account").first()).toBeVisible();
    await expect(
      page
        .locator('[data-slot="card"]')
        .filter({ hasText: "Add a staff account" })
        .getByRole("combobox"),
    ).toBeVisible();
  });

  test("each staff row has at least one action button", async ({ page }) => {
    const rows = page.locator("table tbody tr");
    expect(await rows.count()).toBeGreaterThanOrEqual(3);
    await expect(rows.first().getByRole("button").first()).toBeVisible();
  });

  test("a manager account offers no role control, and no remove when last", async ({
    page,
  }) => {
    // Every manager can open this page, so a role control here would let any
    // manager unmake any other. The server refuses it too.
    //
    // Remove IS offered for a manager in general — that is how a second manager
    // account is taken back — but not here: this account is Oceanview's only
    // manager, and removing it would leave the league with nobody able to grant
    // anyone access to it. See 16-league-membership for the case where a league
    // has two and the button appears.
    await page.goto("/obhl/manage/people");

    const managerRow = page
      .locator("table tbody tr")
      .filter({ hasText: "manager@obhl.test" });
    await expect(managerRow).toHaveCount(1);
    await expect(managerRow.getByText("Role changed by hand")).toBeVisible();
    await expect(managerRow.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(managerRow.getByLabel("Change role")).toHaveCount(0);

    // A non-manager row still has both.
    const otherRow = page
      .locator("table tbody tr")
      .filter({ hasText: "scorekeeper@obhl.test" });
    await expect(otherRow.getByRole("button", { name: "Remove" })).toBeVisible();
    await expect(otherRow.getByLabel("Change role")).toBeVisible();
  });

  // Guards the trap in src/lib/audit.ts: an entity_type leagueOfEntity does not
  // handle logs with a null league, which RLS and the audit page's league filter
  // both hide. Asserting the row was written is not enough — it has to appear in
  // the league-scoped view a manager actually reads.
  test("adding a staff account appears in this league's audit log", async ({
    page,
  }) => {
    const email = `audit-probe-${Date.now()}@obhl.test`;
    const card = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Add a staff account" });

    await card.getByLabel("Email").fill(email);
    await card.getByLabel("Display name").fill("Audit Probe");
    await card.getByRole("button", { name: "Add staff account" }).click();
    // By cell, not text: the success message repeats the address, and an
    // unscoped match resolves to both.
    await expect(page.getByRole("cell", { name: email, exact: true })).toBeVisible();

    await page.goto("/obhl/manage/audit");
    await expect(
      page.getByText("Added Audit Probe as scorekeeper"),
    ).toBeVisible();

    // A role change too, on the account this test just made so nothing else
    // depends on it. Captain, deliberately not Manager: promoting it would make
    // the row un-demotable and leave a second manager in a league whose other
    // tests reason about how many it has.
    await page.goto("/obhl/manage/people");
    const row = page
      .locator("table tbody tr")
      .filter({ hasText: email });
    await row.getByLabel("Change role").selectOption("captain");
    // By cell: the row's own select contains an <option>Captain</option> too,
    // so an unscoped text match is ambiguous.
    await expect(
      row.getByRole("cell", { name: "Captain", exact: true }),
    ).toBeVisible();

    await page.goto("/obhl/manage/audit");
    await expect(
      page.getByText("Changed Audit Probe from scorekeeper to captain"),
    ).toBeVisible();
  });

  test("the add-account form cannot demote an existing manager", async ({
    page,
  }) => {
    // "Add a staff account" reaches existing accounts: a known email fails
    // createUser, and the profile is then upserted with the submitted role.
    // The manager's own address is listed in the table right above this form.
    await page.goto("/obhl/manage/people");

    // Role defaults to scorekeeper, so submitting as-is is the demotion.
    await page.getByLabel("Email").fill("manager@obhl.test");
    await page.getByLabel("Display name").fill("Demoted");
    await page.getByRole("button", { name: "Add staff account" }).click();

    // The form's own refusal, not the row label — StaffRowActions renders
    // "Managers are changed by hand" in the table too, so a looser matcher here
    // passes with the guard removed.
    await expect(
      page.getByText(/manager@obhl\.test is a manager account/),
    ).toBeVisible();

    // Still a manager, and the display name was not overwritten either.
    await page.reload();
    const managerRow = page
      .locator("table tbody tr")
      .filter({ hasText: "manager@obhl.test" });
    // The role cell specifically: a demoted row would still contain the word
    // "Manager" in its role <select>.
    await expect(managerRow.locator("td").nth(2)).toHaveText("Manager");
    await expect(managerRow).not.toContainText("Demoted");
  });
});

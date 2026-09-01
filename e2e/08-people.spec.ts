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

  test("a manager account offers no role or remove control", async ({ page }) => {
    // Every manager can open this page, so offering these would let any manager
    // demote or delete any other — and Remove calls auth.admin.deleteUser,
    // which does not come back. The server refuses it too.
    await page.goto("/obhl/manage/people");

    const managerRow = page
      .locator("table tbody tr")
      .filter({ hasText: "manager@obhl.test" });
    await expect(managerRow).toHaveCount(1);
    await expect(managerRow.getByText("Managers are changed by hand")).toBeVisible();
    await expect(managerRow.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(managerRow.getByLabel("Change role")).toHaveCount(0);

    // A non-manager row still has both.
    const otherRow = page
      .locator("table tbody tr")
      .filter({ hasText: "scorekeeper@obhl.test" });
    await expect(otherRow.getByRole("button", { name: "Remove" })).toBeVisible();
    await expect(otherRow.getByLabel("Change role")).toBeVisible();
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

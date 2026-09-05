/**
 * Path 20: the League Office — a tier above the league manager.
 *
 * What this file exists to catch is the half the other suites structurally
 * cannot. Every other spec signs in as an account that BELONGS to the leagues it
 * touches, so implicit membership — reach with no `profile_leagues` row — is
 * never exercised, and a guard that consults the office and one that does not
 * behave identically.
 *
 * The office accounts are seeded with NO memberships on purpose. If a test here
 * ever starts passing because someone gave them one, it is measuring nothing.
 */
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

const COMMISSIONER = "commissioner@obhl.test";
const DEPUTY = "deputy@obhl.test";

async function signInAs(
  page: Page,
  label: "Manager" | "Commissioner" | "Deputy" | "One-league mgr",
) {
  await page.goto("/login");
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForURL("/");
}

/**
 * Rewrite a hidden input, then PROVE it stuck before anything is submitted.
 *
 * The same helper and the same reason as `16-league-membership.spec.ts`: setting
 * `.value` before hydration lands is undone when React takes over, and the form
 * posts its original value — which on a slow runner means the attack never
 * happened and the test passes anyway. Never submit an unverified tamper.
 */
async function tamper(page: Page, field: Locator, value: string) {
  await page.waitForLoadState("networkidle");
  await field.evaluate((el, v) => ((el as HTMLInputElement).value = v), value);
  await expect(field).toHaveValue(value);
}

async function profileIdFor(email: string) {
  const { data } = await admin().auth.admin.listUsers();
  const id = data!.users.find((u) => u.email === email)?.id;
  if (!id) throw new Error(`no account for ${email}`);
  return id;
}

test.describe("Path 20 — League Office", () => {
  test("the office fixtures hold no membership rows, so the rest means something", async () => {
    const db = admin();
    for (const email of [COMMISSIONER, DEPUTY]) {
      const id = await profileIdFor(email);
      const { data } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", id);
      expect(data ?? [], `${email} must belong to no league`).toHaveLength(0);
    }
  });

  test("a commissioner opens a league they hold no membership row for", async ({
    page,
  }) => {
    await signInAs(page, "Commissioner");

    // Driven, not asserted: the office branch of `memberLeagueIds` is what makes
    // these pages answer at all.
    for (const slug of ["obhl", "harbor"]) {
      await page.goto(`/${slug}/people`);
      await expect(
        page.getByRole("heading", { name: "People & Roles" }),
        `the office should reach /${slug}`,
      ).toBeVisible();
    }

    // ...and the switcher offers every league, not none.
    await page.goto("/obhl/dashboard");
    await expect(page.getByLabel("Select league")).toBeVisible();
  });

  /**
   * The page was reachable only by typing the URL for three phases, because
   * every test here navigates with `page.goto`. Discovery needs its own test or
   * the guard proves nothing about whether anyone can find the page.
   */
  test("the office is reachable from the nav, and only by the office", async ({
    page,
  }) => {
    await signInAs(page, "Commissioner");
    await page.goto("/obhl/dashboard");

    const link = page.getByRole("link", { name: "League Office" });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL("/manage/office");
    await expect(
      page.getByRole("heading", { name: "League Office" }),
    ).toBeVisible();

    // Control: an ordinary manager holds the same ROLE and must not see it —
    // the link is gated on the tier, and a role-keyed nav would leak it to
    // every manager.
    await signInAs(page, "Manager");
    await page.goto("/obhl/dashboard");
    await expect(page.getByRole("link", { name: "League Office" })).toHaveCount(
      0,
    );
  });

  test("office members are listed in a league's staff, read-only", async ({
    page,
  }) => {
    await signInAs(page, "Manager");
    await page.goto("/obhl/people");

    const row = page
      .locator("table tbody tr")
      .filter({ hasText: COMMISSIONER });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Commissioner");
    await expect(row.getByText("Managed in League Office")).toBeVisible();
    await expect(row.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(row.getByLabel("Change role")).toHaveCount(0);

    // Control: an ordinary row still has its controls, so the office branch did
    // not simply disable the table.
    const other = page
      .locator("table tbody tr")
      .filter({ hasText: "scorekeeper@obhl.test" });
    await expect(other.getByLabel("Change role")).toHaveCount(1);
  });

  test("a commissioner demotes a league manager, which no manager can do", async ({
    page,
  }) => {
    const db = admin();
    // A throwaway target, so demoting it cannot perturb a shared fixture.
    const email = `demote-me-${Date.now()}@obhl.test`;
    const { data: created } = await db.auth.admin.createUser({
      email,
      password: "hockey123",
      email_confirm: true,
    });
    const targetId = created!.user!.id;
    await db.from("profiles").upsert({
      id: targetId,
      role: "league_manager",
      display_name: "Demote Me",
    });
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    await db
      .from("profile_leagues")
      .insert({ profile_id: targetId, league_id: league!.id });

    try {
      // First: an ordinary manager is offered nothing on that row. This is the
      // half that must NOT change.
      await signInAs(page, "Manager");
      await page.goto("/obhl/people");
      const asManager = page
        .locator("table tbody tr")
        .filter({ hasText: email });
      await expect(asManager).toHaveCount(1);
      await expect(asManager.getByLabel("Change role")).toHaveCount(0);

      // Then the same row as a commissioner: the control is there, and it works.
      await signInAs(page, "Commissioner");
      await page.goto("/obhl/people");
      const asCommissioner = page
        .locator("table tbody tr")
        .filter({ hasText: email });
      await expect(
        asCommissioner.getByLabel("Change role"),
        "a commissioner outranks a manager and the row must offer the control",
      ).toHaveCount(1);

      await asCommissioner
        .getByLabel("Change role")
        .selectOption("scorekeeper");
      await page.waitForLoadState("networkidle");

      const { data: after } = await db
        .from("profiles")
        .select("role")
        .eq("id", targetId)
        .single();
      expect(after?.role, "the demotion must actually land").toBe(
        "scorekeeper",
      );
    } finally {
      await db.auth.admin.deleteUser(targetId);
    }
  });

  /**
   * ⚠️ This proves the OUTCOME, not the mechanism, and the difference matters.
   *
   * The forged write is refused by `updateStaffRole`'s FIRST gate — `isMemberOf`
   * — because an office member holds no `profile_leagues` row. It never reaches
   * `mayWriteProfileOf`. Watched: with `mayWriteProfileOf` stubbed to `true` this
   * test still passes.
   *
   * That is not a hole. The office branch of `mayWriteProfileOf` is unreachable
   * from every app path — every office member is a `league_manager`, so the
   * demotion guard fires before it, and `createStaffAccount` returns earlier
   * still for any account that already holds a role. The rule itself is covered
   * by the nine-cell matrix in `precedence.test.ts`, and the half that actually
   * guards a hostile caller is the RLS one, probed on the anon key.
   *
   * Keep the test: a forged id must not land, whichever gate stops it.
   */
  test("a manager forging a commissioner's id does not land — role direction", async ({
    page,
  }) => {
    const db = admin();
    const commissionerId = await profileIdFor(COMMISSIONER);
    const { data: before } = await db
      .from("profiles")
      .select("role")
      .eq("id", commissionerId)
      .single();

    await signInAs(page, "Manager");
    await page.goto("/obhl/people");

    // Borrow a row that legitimately HAS the control, then point it at the
    // commissioner. Their own row offers nothing to tamper with, which is the
    // point of it being read-only.
    const donor = page
      .locator("table tbody tr")
      .filter({ hasText: "scorekeeper@obhl.test" });
    // Scoped to the ROLE form: the row carries two `input[name="id"]`, one per
    // form, and an unscoped locator matches both.
    const roleForm = donor
      .locator("form")
      .filter({ has: page.getByLabel("Change role") });
    await tamper(page, roleForm.locator('input[name="id"]'), commissionerId);
    await roleForm.getByLabel("Change role").selectOption("captain");
    await page.waitForLoadState("networkidle");

    const { data: after } = await db
      .from("profiles")
      .select("role")
      .eq("id", commissionerId)
      .single();
    expect(after?.role, "the forged write must not land").toBe(before!.role);
    expect(after?.role).toBe("league_manager");
  });

  test("a manager forging a commissioner's id is refused — remove direction", async ({
    page,
  }) => {
    const db = admin();
    const commissionerId = await profileIdFor(COMMISSIONER);

    await signInAs(page, "Manager");
    await page.goto("/obhl/people");

    const donor = page
      .locator("table tbody tr")
      .filter({ hasText: "scorekeeper@obhl.test" });
    const removeForm = donor
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "Remove" }) });
    await tamper(page, removeForm.locator('input[name="id"]'), commissionerId);
    await removeForm.getByRole("button", { name: "Remove" }).click();
    await page.waitForLoadState("networkidle");

    // Still in the office, and still a manager: `removeStaff` refused rather
    // than reporting success having deleted nothing.
    const { data: tier } = await db
      .from("league_office")
      .select("tier")
      .eq("profile_id", commissionerId)
      .single();
    expect(tier?.tier).toBe("commissioner");
    const { data: prof } = await db
      .from("profiles")
      .select("role")
      .eq("id", commissionerId)
      .single();
    expect(prof?.role).toBe("league_manager");
  });

  test("a deputy sees the office roster and can change nothing", async ({
    page,
  }) => {
    await signInAs(page, "Deputy");
    await page.goto("/manage/office");

    await expect(
      page.getByRole("heading", { name: "League Office" }),
    ).toBeVisible();
    // The roster is visible...
    await expect(
      page.getByRole("cell", { name: COMMISSIONER, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: DEPUTY, exact: true }),
    ).toBeVisible();
    // ...and nothing on it is actionable, including their own row.
    await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(page.getByLabel("Manager account")).toHaveCount(0);
    await expect(page.getByText("View only").first()).toBeVisible();
  });

  test("a commissioner can revoke a deputy's tier, and put it back", async ({
    page,
  }) => {
    const db = admin();
    const deputyId = await profileIdFor(DEPUTY);

    await signInAs(page, "Commissioner");
    await page.goto("/manage/office");

    const row = page.locator("table tbody tr").filter({ hasText: DEPUTY });
    await row.getByRole("button", { name: "Remove" }).click();
    await expect(
      page.locator("table tbody tr").filter({ hasText: DEPUTY }),
    ).toHaveCount(0);

    const { data: gone } = await db
      .from("league_office")
      .select("tier")
      .eq("profile_id", deputyId);
    expect(gone ?? [], "the tier must actually be revoked").toHaveLength(0);

    // Restore through the UI, which is also the appoint path.
    await page.getByLabel("Manager account").selectOption(deputyId);
    await page.getByRole("button", { name: "Appoint as deputy" }).click();
    await expect(
      page.locator("table tbody tr").filter({ hasText: DEPUTY }),
    ).toHaveCount(1);

    const { data: back } = await db
      .from("league_office")
      .select("tier")
      .eq("profile_id", deputyId)
      .single();
    expect(back?.tier).toBe("deputy");
  });

  test("removeStaff refuses an office member, and the row says why", async ({
    page,
  }) => {
    const db = admin();
    const deputyId = await profileIdFor(DEPUTY);
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();

    // A deputy WITH a membership row — the shape a promoted manager leaves, and
    // the only one where `removeStaff` reaches its office check rather than
    // bouncing off the membership check first.
    await db
      .from("profile_leagues")
      .insert({ profile_id: deputyId, league_id: league!.id });

    try {
      await signInAs(page, "Manager");
      await page.goto("/obhl/people");

      const row = page.locator("table tbody tr").filter({ hasText: DEPUTY });
      await expect(row).toHaveCount(1);
      // "Says so": a reason, not a button that would do nothing.
      await expect(row.getByText("Managed in League Office")).toBeVisible();
      await expect(row.getByRole("button", { name: "Remove" })).toHaveCount(0);

      // And the server half, forged from a donor row.
      const donor = page
        .locator("table tbody tr")
        .filter({ hasText: "scorekeeper@obhl.test" });
      const removeForm = donor
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Remove" }) });
      await tamper(page, removeForm.locator('input[name="id"]'), deputyId);
      await removeForm.getByRole("button", { name: "Remove" }).click();
      await page.waitForLoadState("networkidle");

      const { data: still } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", deputyId)
        .eq("league_id", league!.id);
      expect(
        still ?? [],
        "the membership must survive: a no-op that logged a removal is the bug",
      ).toHaveLength(1);
    } finally {
      await db
        .from("profile_leagues")
        .delete()
        .eq("profile_id", deputyId)
        .eq("league_id", league!.id);
    }
  });
});

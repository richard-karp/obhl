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

test.describe("Path 13 — Announcements", () => {
  // The audit null-league trap (`RUNBOOK.md` → Access control → Traps). The post resolves through
  // `leagueOfEntity`'s `announcement` case; the delete passes `league_id`, since its row is gone.
  test("posting and deleting an announcement both land in this league's audit log", async ({
    page,
  }) => {
    const title = `Audit Probe Announcement ${Date.now()}`;
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();

    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto("/obhl/announcements");
    await page
      .getByLabel("Title")
      .or(page.getByPlaceholder("Title"))
      .fill(title);
    await page
      .getByLabel("Message")
      .or(page.getByPlaceholder("Write the announcement…"))
      .fill("Posted by an automated test to check the audit log.");
    await page.getByRole("button", { name: "Post announcement" }).click();
    await page.waitForLoadState("networkidle");

    // The id, while the row exists: reading the newest rows by action would match any other
    // announcement's entry.
    const { data: posted } = await db
      .from("announcements")
      .select("id")
      .eq("title", title)
      .single();

    await page.goto("/obhl/audit");
    await expect(page.getByText(`Posted "${title}"`)).toBeVisible();

    await page.goto("/obhl/announcements");
    await page
      .locator('[data-slot="card"]')
      .filter({ hasText: title })
      .getByRole("button", { name: "Delete" })
      .click();
    await page.waitForLoadState("networkidle");

    await page.goto("/obhl/audit");
    await expect(page.getByText(`Deleted "${title}"`)).toBeVisible();

    // …and neither entry was filed under a null league, which is the state the
    // page above cannot distinguish from "no entry was written at all".
    const { data: entries } = await db
      .from("audit_log")
      .select("action, league_id")
      .eq("entity_id", posted!.id);
    const byAction = new Map(
      (entries ?? []).map((e) => [e.action, e.league_id]),
    );
    for (const action of ["create_announcement", "delete_announcement"]) {
      expect(byAction.has(action), `${action} wrote no audit entry`).toBe(true);
      expect(byAction.get(action), `${action} was filed under no league`).toBe(
        league!.id,
      );
    }
  });
});

test.describe("Path 14 — People & Roles", () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto("/obhl/people");
  });

  test("a manager account offers no role control, and no remove when last", async ({
    page,
  }) => {
    // A role control here would let any manager unmake another; the server refuses too. No Remove:
    // this is Oceanview's only manager (`09-access` covers a league with two).
    await page.goto("/obhl/people");

    const managerRow = page
      .locator("table tbody tr")
      .filter({ hasText: "manager@obhl.test" });
    await expect(managerRow).toHaveCount(1);
    await expect(
      managerRow.getByText("Role changed by a commissioner"),
    ).toBeVisible();
    await expect(
      managerRow.getByRole("button", { name: "Remove" }),
    ).toHaveCount(0);
    await expect(managerRow.getByLabel("Change role")).toHaveCount(0);

    // A non-manager row still has both.
    const otherRow = page
      .locator("table tbody tr")
      .filter({ hasText: "scorekeeper@obhl.test" });
    await expect(
      otherRow.getByRole("button", { name: "Remove" }),
    ).toBeVisible();
    await expect(otherRow.getByLabel("Change role")).toBeVisible();
  });

  // The audit null-league trap (`RUNBOOK.md` → Access control → Traps): the entry must appear in
  // the league-scoped view, not merely exist.
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
    await expect(
      page.getByRole("cell", { name: email, exact: true }),
    ).toBeVisible();

    await page.goto("/obhl/audit");
    await expect(
      page.getByText("Added Audit Probe as scorekeeper"),
    ).toBeVisible();

    // A role change on this test's own account. Captain, not Manager: a promotion can't be undone
    // here and leaves a second manager in a league other tests count.
    await page.goto("/obhl/people");
    const row = page.locator("table tbody tr").filter({ hasText: email });
    await row.getByLabel("Change role").selectOption("captain");
    // By cell: the row's own select contains an <option>Captain</option> too,
    // so an unscoped text match is ambiguous.
    await expect(
      row.getByRole("cell", { name: "Captain", exact: true }),
    ).toBeVisible();

    await page.goto("/obhl/audit");
    await expect(
      page.getByText("Changed Audit Probe from scorekeeper to captain"),
    ).toBeVisible();
  });

  test("the add-account form cannot demote an existing manager", async ({
    page,
  }) => {
    // "Add a staff account" reaches existing accounts: a known email fails createUser, and the
    // profile is then upserted with the submitted role.
    await page.goto("/obhl/people");

    // Role defaults to scorekeeper, so submitting as-is is the demotion.
    await page.getByLabel("Email").fill("manager@obhl.test");
    await page.getByLabel("Display name").fill("Demoted");
    await page.getByRole("button", { name: "Add staff account" }).click();

    // The form's own refusal, not the row label: the table also says "Role changed by a
    // commissioner", so a looser matcher passes with the guard removed.
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

  // The branch writing `grant_league`: an existing manager added at their own role gains membership
  // only. Undone in `finally`: `09-access`'s `beforeAll` fails by name if this account is in two leagues.
  test("granting an existing manager a second league is audited", async ({
    page,
  }) => {
    const guest = "single-league-lead@obhl.test";
    const db = admin();
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    const { data: profile } = await db
      .from("profiles")
      .select("id")
      .eq("display_name", "Single League Manager")
      .single();
    // Stated, not assumed: if the seed ever puts this account in obhl already,
    // the add below is a no-op and the test would pass having granted nothing.
    const { data: mine } = await db
      .from("profile_leagues")
      .select("league_id")
      .eq("profile_id", profile!.id);
    expect(
      (mine ?? []).map((r) => r.league_id),
      "the guest manager must start outside this league",
    ).not.toContain(league!.id);

    try {
      await page.goto("/obhl/people");
      const card = page
        .locator('[data-slot="card"]')
        .filter({ hasText: "Add a staff account" });
      await card.getByLabel("Email").fill(guest);
      await card.getByLabel("Display name").fill("Single League Manager");
      await card.getByRole("combobox").click();
      await page.getByRole("option", { name: "League manager" }).click();
      await card.getByRole("button", { name: "Add staff account" }).click();

      // The manager wording, not the scorekeeper one — this is the branch under
      // test, and the other says "now works this league too".
      await expect(card.getByText(/now manages this league too/)).toBeVisible();

      await page.goto("/obhl/audit");
      await expect(page.getByText(`Gave ${guest} this league`)).toBeVisible();

      // An entry filed under no league renders as nothing, like one never written, so read the row.
      const { data: entry } = await db
        .from("audit_log")
        .select("league_id, new_data")
        .eq("action", "grant_league")
        .eq("entity_id", league!.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      expect(entry, "grant_league wrote no audit entry").not.toBeNull();
      expect(entry!.league_id).toBe(league!.id);
    } finally {
      await db
        .from("profile_leagues")
        .delete()
        .eq("profile_id", profile!.id)
        .eq("league_id", league!.id);
    }
  });
});

async function openEditor(page: Page) {
  await page.goto("/obhl/rules");
  await page.getByRole("button", { name: "Edit rules" }).click();
}

const RULES_TEXT = `E2E test rule: no high-sticking at ${Date.now()}`;

test.describe("Path 16 — League Rules", () => {
  test("manager saves rules and they appear on the public rules page", async ({
    page,
  }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");
    await openEditor(page);

    // Type into the Tiptap contenteditable editor
    const editor = page.locator('[contenteditable="true"]');
    await editor.click();
    await editor.fill(RULES_TEXT);

    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10000 });

    // Verify content appears on the public rules page
    await page.goto("/obhl/rules");
    await expect(page.getByText(RULES_TEXT)).toBeVisible();
  });

  // The audit null-league trap (`RUNBOOK.md` → Access control → Traps): the entry must appear in
  // the league-scoped view, not merely exist.
  test("saving rules appears in this league's audit log", async ({ page }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");
    await openEditor(page);

    const editor = page.locator('[contenteditable="true"]');
    await editor.click();
    await editor.fill(`Audited rule change at ${Date.now()}`);
    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10000 });

    await page.goto("/obhl/audit");
    await expect(page.getByText("Updated league rules").first()).toBeVisible();

    // Re-saving an untouched page must not add a second entry. Only the current session's card is
    // expanded, so this count is this test's own entries.
    await openEditor(page);
    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10000 });

    await page.goto("/obhl/audit");
    await expect(page.getByText("Updated league rules")).toHaveCount(1);
  });

  test("public rules page is accessible without login", async ({ page }) => {
    await page.goto("/obhl/rules");
    // Either shows rules content or the empty state — never an auth redirect
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page.locator("h1").filter({ hasText: "League Rules" }),
    ).toBeVisible();
  });

  test("an anonymous visitor is offered no way to edit", async ({ page }) => {
    // The merge's whole risk in one assertion: the page that gained an editor
    // must not have gained it for everybody.
    await page.goto("/obhl/rules");
    await expect(page.getByRole("button", { name: "Edit rules" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Save rules" })).toHaveCount(
      0,
    );
  });

  // The old `/obhl/rules/edit` → `/obhl/rules` redirect is asserted in
  // `09-access.spec.ts`'s "every legacy URL still lands on its page".
});

// The office accounts are seeded with NO memberships, so these exercise reach with no
// `profile_leagues` row. A test passing because one gained a row measures nothing.
const COMMISSIONER = "commissioner@obhl.test";
const DEPUTY = "deputy@obhl.test";

// Wait for the POST: every assertion here is about something NOT written, and a read fired straight
// after `click()` reads "nothing yet" and passes with the guard deleted.
async function submitAndSettle(page: Page, click: Promise<unknown>) {
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await click;
  await posted;
}

// A `.value` set before hydration is undone and the form posts its ORIGINAL value, so the attack never
// happens and the test passes. So settle, set, and assert.
async function tamper(page: Page, field: Locator, value: string) {
  await page.waitForLoadState("networkidle");
  await field.evaluate((el, v) => ((el as HTMLInputElement).value = v), value);
  await expect(field).toHaveValue(value);
}

/** Does this address + password actually sign in? The only honest test of a set password. */
async function canSignIn(email: string, password: string) {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error } = await client.auth.signInWithPassword({ email, password });
  return !error;
}

async function profileIdFor(email: string) {
  const { data } = await admin().auth.admin.listUsers();
  const id = data!.users.find((u) => u.email === email)?.id;
  if (!id) throw new Error(`no account for ${email}`);
  return id;
}

test.describe("Path 20 — League Office", () => {
  test("a commissioner opens a league they hold no membership row for", async ({
    page,
  }) => {
    // The office accounts must hold no memberships, or every office test here measures nothing.
    const db = admin();
    for (const email of [COMMISSIONER, DEPUTY]) {
      const { data } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", await profileIdFor(email));
      expect(data ?? [], `${email} must belong to no league`).toHaveLength(0);
    }

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

  // ⚠️ Proves the OUTCOME: `isMemberOf` refuses first (the office holds no membership row), so
  // `mayWriteProfileOf` is never reached; its rule is covered by `precedence.test.ts`.
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

    // Borrow a row that has the control and point it at the commissioner, whose own row offers
    // nothing to tamper with.
    const donor = page
      .locator("table tbody tr")
      .filter({ hasText: "scorekeeper@obhl.test" });
    // Scoped to the ROLE form: the row carries two `input[name="id"]`, one per
    // form, and an unscoped locator matches both.
    const roleForm = donor
      .locator("form")
      .filter({ has: page.getByLabel("Change role") });
    await tamper(page, roleForm.locator('input[name="id"]'), commissionerId);
    await submitAndSettle(
      page,
      roleForm.getByLabel("Change role").selectOption("captain"),
    );

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
    const since = new Date(Date.now() - 5_000).toISOString();

    await signInAs(page, "Manager");
    await page.goto("/obhl/people");

    const donor = page
      .locator("table tbody tr")
      .filter({ hasText: "scorekeeper@obhl.test" });
    const removeForm = donor
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "Remove" }) });
    await tamper(page, removeForm.locator('input[name="id"]'), commissionerId);
    await submitAndSettle(
      page,
      removeForm.getByRole("button", { name: "Remove" }).click(),
    );

    // Still in the office. The audit entry catches a broken guard: a forged removal deletes no
    // membership row and only files a `remove_staff` entry saying it did.
    const { data: tier } = await db
      .from("league_office")
      .select("tier")
      .eq("profile_id", commissionerId)
      .single();
    expect(tier?.tier).toBe("commissioner");
    const { data: entries } = await db
      .from("audit_log")
      .select("id")
      .eq("action", "remove_staff")
      .contains("old_data", { profile_id: commissionerId })
      .gte("created_at", since);
    expect(
      entries ?? [],
      "a refused removal must file no remove_staff entry",
    ).toHaveLength(0);
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

    // A deputy WITH a membership row: the only shape where `removeStaff` reaches its office check
    // rather than bouncing off the membership check.
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
      await submitAndSettle(
        page,
        removeForm.getByRole("button", { name: "Remove" }).click(),
      );

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

  // ⛔ Asserted by signing in, not the success message: the admin API reports success for a write a
  // policy would refuse. The password opens the account or it doesn't.
  test("a commissioner sets a staff password and the account signs in with it", async ({
    page,
  }) => {
    const db = admin();
    const email = `pw-target-${Date.now()}@obhl.test`;
    const { data: created } = await db.auth.admin.createUser({
      email,
      password: "old-password-000",
      email_confirm: true,
    });
    const targetId = created!.user!.id;
    await db.from("profiles").upsert({
      id: targetId,
      role: "scorekeeper",
      display_name: "Password Target",
    });

    try {
      await signInAs(page, "Commissioner");
      await page.goto("/manage/office");

      await page.getByLabel("Staff email").fill(email);
      await page.getByLabel("New password").fill("brand-new-pw-01");
      await page.getByRole("button", { name: "Set password" }).click();
      await expect(page.getByRole("status")).toContainText("Password set");

      expect(
        await canSignIn(email, "brand-new-pw-01"),
        "the new password must actually open the account",
      ).toBe(true);
      expect(
        await canSignIn(email, "old-password-000"),
        "and the old one must not",
      ).toBe(false);

      // The entry is filed under a NULL league on purpose — the office is
      // instance-wide — and it must never carry the password itself.
      const { data: entries } = await db
        .from("audit_log")
        .select("action, entity_type, league_id, new_data")
        .eq("entity_type", "office")
        .eq("action", "set_password")
        .eq("entity_id", targetId);
      expect(entries ?? []).toHaveLength(1);
      expect(entries![0].league_id).toBeNull();
      expect(
        JSON.stringify(entries![0].new_data),
        "an audit entry must never carry a live credential",
      ).not.toContain("brand-new-pw-01");
    } finally {
      await db.from("audit_log").delete().eq("entity_id", targetId);
      await db.from("profiles").delete().eq("id", targetId);
      await db.auth.admin.deleteUser(targetId);
    }
  });

  // ⛔ A control rendered only for a commissioner is not a restriction (`RUNBOOK.md` → Access control),
  // so replay the real submit from a deputy and a manager with the password swapped.
  test("setStaffPassword refuses a replayed POST from a deputy and from a manager", async ({
    page,
  }) => {
    const db = admin();
    const email = `pw-forge-${Date.now()}@obhl.test`;
    const { data: created } = await db.auth.admin.createUser({
      email,
      password: "old-password-000",
      email_confirm: true,
    });
    const targetId = created!.user!.id;
    await db.from("profiles").upsert({
      id: targetId,
      role: "scorekeeper",
      display_name: "Forge Target",
    });

    try {
      await signInAs(page, "Commissioner");
      await page.goto("/manage/office");

      const posted = page.waitForRequest(
        (r) => r.method() === "POST" && r.url().includes("/manage/office"),
      );
      await page.getByLabel("Staff email").fill(email);
      await page.getByLabel("New password").fill("commissioner-pw-1");
      await page.getByRole("button", { name: "Set password" }).click();
      const request = await posted;
      await expect(page.getByRole("status")).toContainText("Password set");

      const body = request.postDataBuffer();
      const headers = request.headers();
      expect(
        body,
        "the submit must be capturable, or the replays below prove nothing",
      ).toBeTruthy();
      expect(await canSignIn(email, "commissioner-pw-1")).toBe(true);

      // Same 17 characters, so the multipart body's lengths are untouched.
      const forged = Buffer.from(
        body!
          .toString("binary")
          .replace("commissioner-pw-1", "forged-by-them-01"),
        "binary",
      );
      expect(
        forged.equals(body!),
        "the forged body must differ from the captured one",
      ).toBe(false);

      const replayHeaders: Record<string, string> = {
        "content-type": headers["content-type"],
        origin: new URL(page.url()).origin,
      };
      if (headers["next-action"])
        replayHeaders["next-action"] = headers["next-action"];

      for (const who of ["Deputy", "Manager"] as const) {
        // A fresh session per attacker; `page.request` uses the context's cookies.
        await signInAs(page, who);
        await page.request.post("/manage/office", {
          headers: replayHeaders,
          data: forged,
          maxRedirects: 0,
          failOnStatusCode: false,
        });
        expect(
          await canSignIn(email, "forged-by-them-01"),
          `a ${who}'s replayed POST must not land`,
        ).toBe(false);
        expect(
          await canSignIn(email, "commissioner-pw-1"),
          "and the commissioner's password must survive it",
        ).toBe(true);
      }
    } finally {
      await db.from("audit_log").delete().eq("entity_id", targetId);
      await db.from("profiles").delete().eq("id", targetId);
      await db.auth.admin.deleteUser(targetId);
    }
  });

  // Peer-flat: a commissioner who could reset a peer's password could sign in as them and unseat them.
  test("a commissioner cannot set another commissioner's password, but can set their own", async ({
    page,
  }) => {
    const db = admin();
    const email = `peer-commissioner-${Date.now()}@obhl.test`;
    const { data: created } = await db.auth.admin.createUser({
      email,
      password: "peer-old-pw-000",
      email_confirm: true,
    });
    const peerId = created!.user!.id;
    // `league_manager` first — 0034's trigger refuses a tier for any other role.
    await db.from("profiles").upsert({
      id: peerId,
      role: "league_manager",
      display_name: "Peer Commissioner",
    });
    await db
      .from("league_office")
      .upsert(
        { profile_id: peerId, tier: "commissioner" },
        { onConflict: "profile_id" },
      );

    try {
      await signInAs(page, "Commissioner");
      await page.goto("/manage/office");

      await page.getByLabel("Staff email").fill(email);
      await page.getByLabel("New password").fill("peer-takeover-01");
      await page.getByRole("button", { name: "Set password" }).click();
      await expect(page.getByRole("status")).toContainText("peer-flat");

      expect(await canSignIn(email, "peer-takeover-01")).toBe(false);
      expect(
        await canSignIn(email, "peer-old-pw-000"),
        "the peer's account must be untouched",
      ).toBe(true);

      // Their OWN, though, is the bootstrap: a commissioner who arrived by magic
      // link gives themselves a password so the next sign-in needs no email.
      await page.getByLabel("Staff email").fill(COMMISSIONER);
      await page.getByLabel("New password").fill("self-bootstrap-01");
      await page.getByRole("button", { name: "Set password" }).click();
      await expect(page.getByRole("status")).toContainText("Password set");
      expect(await canSignIn(COMMISSIONER, "self-bootstrap-01")).toBe(true);
    } finally {
      // ⛔ PUT THE SEEDED PASSWORD BACK: every other spec's dev-panel sign-in posts `hockey123`, so
      // leaving this changed breaks the suite from here on.
      const commissionerId = await profileIdFor(COMMISSIONER);
      await db.auth.admin.updateUserById(commissionerId, {
        password: "hockey123",
      });
      await db.from("audit_log").delete().eq("entity_id", commissionerId);
      await db.from("audit_log").delete().eq("entity_id", peerId);
      await db.from("league_office").delete().eq("profile_id", peerId);
      await db.from("profiles").delete().eq("id", peerId);
      await db.auth.admin.deleteUser(peerId);
    }
  });
});

test.describe("League switcher", () => {
  test("the manage switcher moves between leagues", async ({ page }) => {
    // It navigates to the league root, not the equivalent sub-path, which would name a season of the
    // league left behind.
    await signInAs(page, "Manager");
    await page.goto("/obhl/seasons");

    await page.getByLabel("Select league").selectOption("harbor");
    await page.waitForURL("/harbor/dashboard");
  });
});

/** Staff tools: announcements, People & Roles, league rules, and the League Office. */
/**
 * Path 13: Announcements — post, verify on homepage, delete.
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
  // Guards the trap in `src/lib/audit.ts`: `leagueOfEntity` returns null for any
  // `entity_type` it does not handle, and a null league is hidden by RLS *and*
  // filtered out of every league-scoped view — so an entry can be written
  // perfectly and never appear anywhere a manager looks. Asserting the row
  // exists is therefore not enough; both halves are checked here.
  //
  // The two announcement entries reach their league by different routes on
  // purpose. The post resolves through the `announcement` case in that switch,
  // because its row still exists. The delete cannot — by the time it is logged
  // the row is gone and the switch has nothing to read — so it passes
  // `league_id` outright. Knock the switch case out and only the first goes red.
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

    // The id, while the row still exists. Both audit assertions below scope to
    // it — reading the newest rows by action instead would match an entry from
    // any other announcement, including one an earlier test in this file made.
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

/**
 * Path 14: People & Roles — view staff listing and form structure.
 */
test.describe("Path 14 — People & Roles", () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, "Manager", "/obhl/dashboard");
    await page.goto("/obhl/people");
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
    // anyone access to it. See 09-access for the case where a league
    // has two and the button appears.
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
    await expect(
      page.getByRole("cell", { name: email, exact: true }),
    ).toBeVisible();

    await page.goto("/obhl/audit");
    await expect(
      page.getByText("Added Audit Probe as scorekeeper"),
    ).toBeVisible();

    // A role change too, on the account this test just made so nothing else
    // depends on it. Captain, deliberately not Manager: promoting it would make
    // the row un-demotable and leave a second manager in a league whose other
    // tests reason about how many it has.
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
    // "Add a staff account" reaches existing accounts: a known email fails
    // createUser, and the profile is then upserted with the submitted role.
    // The manager's own address is listed in the table right above this form.
    await page.goto("/obhl/people");

    // Role defaults to scorekeeper, so submitting as-is is the demotion.
    await page.getByLabel("Email").fill("manager@obhl.test");
    await page.getByLabel("Display name").fill("Demoted");
    await page.getByRole("button", { name: "Add staff account" }).click();

    // The form's own refusal, not the row label — StaffRowActions renders
    // "Role changed by a commissioner" in the table too, so a looser matcher
    // here passes with the guard removed.
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

  /**
   * The one branch of `createStaffAccount` nothing else drives: an existing
   * MANAGER handed a second league.
   *
   * It is the branch that writes `grant_league` — reached when the submitted
   * role matches the one the account already holds, so no profile is written
   * and only membership changes. That is deliberately the flow that lets one
   * person manage both leagues, and it is the one an audit log most needs to
   * record.
   *
   * Its own test rather than a line bolted onto another, because it changes how
   * many managers a league has, and `09-access.spec.ts` reasons about
   * exactly that — for `harbor` in every one of its tests, and its `beforeAll`
   * fails loudly by name if this account is left in two leagues. The grant is
   * undone in `finally`.
   */
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

      // Visible on the page is the half that matters, but an entry filed under
      // no league renders as nothing at all — indistinguishable from one that
      // was never written. So read the row too.
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

/**
 * Path 16: League Rules — one page, two hats.
 *
 * `/rules` and `/manage/rules/edit` were two URLs over one thing. The public
 * page now carries the editor for whoever is entitled to it, so every test here
 * drives `/obhl/rules` and the manager's tests open the editor from it.
 */
/** The shared page, then the editor a manager is offered on it. */
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

  // Guards the trap in src/lib/audit.ts: an entity_type that leagueOfEntity
  // does not handle logs with a null league, and the audit page filters on
  // `league_id`. The entry would be written correctly and never be seen, so
  // asserting it was written is not enough — it has to appear in the
  // league-scoped view a manager actually reads.
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

    // Saving again without editing must not add a second entry: these entries
    // carry two whole documents, and re-saving an untouched page changed
    // nothing. Only the current session's card is expanded, so a count here is
    // a count of this test's own entries.
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
const COMMISSIONER = "commissioner@obhl.test";
const DEPUTY = "deputy@obhl.test";

/**
 * Submit and wait for the action to actually finish.
 *
 * Every assertion below is about something NOT being written, and a DB read
 * fired straight after `click()` races the action — it reads "nothing yet"
 * and the test passes whether the guard is there or not. That is how the
 * first version of these tests passed against a deliberately broken guard.
 */
async function submitAndSettle(page: Page, click: Promise<unknown>) {
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await click;
  await posted;
}

/**
 * Rewrite a hidden input, then PROVE it stuck before anything is submitted.
 *
 * The same helper and the same reason as `09-access.spec.ts`: setting
 * `.value` before hydration lands is undone when React takes over, and the form
 * posts its original value — which on a slow runner means the attack never
 * happened and the test passes anyway. Never submit an unverified tamper.
 */
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
    // Was "the office fixtures hold no membership rows, so the rest means
    // something". The office accounts are seeded with NO memberships; if one
    // ever gains a row, every office test here passes while measuring nothing.
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

    // Still in the office. The audit entry is what catches a broken guard: an
    // office member holds no membership row, so a forged removal that got
    // through deletes nothing and only files a `remove_staff` entry saying it did.
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

  /**
   * Commissioner-set passwords — the recovery path that needs no email.
   *
   * ⛔ ASSERTED BY SIGNING IN, not by reading the form's success message. The
   * admin API reports success for a write that a policy would have refused, and a
   * message rendered by the same request that did the work proves only that the
   * code ran. The password either opens the account or it does not.
   */
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

  /**
   * ⛔ THE GUARD THAT MATTERS, and the one an absent button does not provide.
   *
   * `ACCESS_CONTROL_HANDOFF.md`'s *Traps* section: every export of a
   * `"use server"` file is a callable endpoint, and a control rendered only for a
   * commissioner is a rendering decision, not a restriction. So this replays the
   * commissioner's own submit — verbatim, with only the password swapped — from a
   * deputy's session and then from an ordinary manager's.
   *
   * The swap is length-preserving so the captured multipart body stays
   * well-formed. It also makes the outcome legible: if a replay landed, the
   * forged password opens the account; if it was refused, the commissioner's
   * still does. Replaying the SAME password would be indistinguishable either
   * way — the account would open on it whether or not the second write happened.
   */
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

  /**
   * The tier is peer-flat, and a password is a takeover. A commissioner who could
   * reset a peer's password could sign in as them and unseat them — which is
   * exactly what "appointing or removing a commissioner is done in the database"
   * exists to prevent.
   */
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
      // ⛔ PUT THE SEEDED PASSWORD BACK. Every other spec signs in through the dev
      // panel, which posts `hockey123` and nothing else — leaving this changed
      // would break the whole suite from here on, in whatever order it runs.
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
    // The switcher used to write a cookie. With the league in the URL it has to
    // navigate, and it lands on the league root rather than the equivalent
    // sub-path, which would name a season belonging to the league left behind.
    await signInAs(page, "Manager");
    await page.goto("/obhl/seasons");

    await page.getByLabel("Select league").selectOption("harbor");
    await page.waitForURL("/harbor/dashboard");
  });
});

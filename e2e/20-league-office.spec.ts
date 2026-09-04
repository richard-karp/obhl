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
      await page.goto(`/${slug}/manage/people`);
      await expect(
        page.getByRole("heading", { name: "People & Roles" }),
        `the office should reach /${slug}`,
      ).toBeVisible();
    }

    // ...and the switcher offers every league, not none.
    await page.goto("/obhl/manage/dashboard");
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
    await page.goto("/obhl/manage/dashboard");

    const link = page.getByRole("link", { name: "League Office" });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL("/manage/office");
    await expect(page.getByRole("heading", { name: "League Office" })).toBeVisible();

    // Control: an ordinary manager holds the same ROLE and must not see it —
    // the link is gated on the tier, and a role-keyed nav would leak it to
    // every manager.
    await signInAs(page, "Manager");
    await page.goto("/obhl/manage/dashboard");
    await expect(page.getByRole("link", { name: "League Office" })).toHaveCount(0);
  });

  test("office members are listed in a league's staff, read-only", async ({
    page,
  }) => {
    await signInAs(page, "Manager");
    await page.goto("/obhl/manage/people");

    const row = page.locator("table tbody tr").filter({ hasText: COMMISSIONER });
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
      email, password: "hockey123", email_confirm: true,
    });
    const targetId = created!.user!.id;
    await db.from("profiles").upsert({
      id: targetId, role: "league_manager", display_name: "Demote Me",
    });
    const { data: league } = await db
      .from("leagues").select("id").eq("slug", "obhl").single();
    await db.from("profile_leagues")
      .insert({ profile_id: targetId, league_id: league!.id });

    try {
      // First: an ordinary manager is offered nothing on that row. This is the
      // half that must NOT change.
      await signInAs(page, "Manager");
      await page.goto("/obhl/manage/people");
      const asManager = page.locator("table tbody tr").filter({ hasText: email });
      await expect(asManager).toHaveCount(1);
      await expect(asManager.getByLabel("Change role")).toHaveCount(0);

      // Then the same row as a commissioner: the control is there, and it works.
      await signInAs(page, "Commissioner");
      await page.goto("/obhl/manage/people");
      const asCommissioner = page
        .locator("table tbody tr")
        .filter({ hasText: email });
      await expect(
        asCommissioner.getByLabel("Change role"),
        "a commissioner outranks a manager and the row must offer the control",
      ).toHaveCount(1);

      await asCommissioner.getByLabel("Change role").selectOption("scorekeeper");
      await page.waitForLoadState("networkidle");

      const { data: after } = await db
        .from("profiles").select("role").eq("id", targetId).single();
      expect(after?.role, "the demotion must actually land").toBe("scorekeeper");
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
      .from("profiles").select("role").eq("id", commissionerId).single();

    await signInAs(page, "Manager");
    await page.goto("/obhl/manage/people");

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
      .from("profiles").select("role").eq("id", commissionerId).single();
    expect(after?.role, "the forged write must not land").toBe(before!.role);
    expect(after?.role).toBe("league_manager");
  });

  test("a manager forging a commissioner's id is refused — remove direction", async ({
    page,
  }) => {
    const db = admin();
    const commissionerId = await profileIdFor(COMMISSIONER);

    await signInAs(page, "Manager");
    await page.goto("/obhl/manage/people");

    const donor = page
      .locator("table tbody tr")
      .filter({ hasText: "scorekeeper@obhl.test" });
    const removeForm = donor.locator("form").filter({ has: page.getByRole("button", { name: "Remove" }) });
    await tamper(page, removeForm.locator('input[name="id"]'), commissionerId);
    await removeForm.getByRole("button", { name: "Remove" }).click();
    await page.waitForLoadState("networkidle");

    // Still in the office, and still a manager: `removeStaff` refused rather
    // than reporting success having deleted nothing.
    const { data: tier } = await db
      .from("league_office").select("tier").eq("profile_id", commissionerId).single();
    expect(tier?.tier).toBe("commissioner");
    const { data: prof } = await db
      .from("profiles").select("role").eq("id", commissionerId).single();
    expect(prof?.role).toBe("league_manager");
  });

  test("a deputy sees the office roster and can change nothing", async ({ page }) => {
    await signInAs(page, "Deputy");
    await page.goto("/manage/office");

    await expect(page.getByRole("heading", { name: "League Office" })).toBeVisible();
    // The roster is visible...
    await expect(page.getByRole("cell", { name: COMMISSIONER, exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: DEPUTY, exact: true })).toBeVisible();
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
    await expect(page.locator("table tbody tr").filter({ hasText: DEPUTY })).toHaveCount(0);

    const { data: gone } = await db
      .from("league_office").select("tier").eq("profile_id", deputyId);
    expect(gone ?? [], "the tier must actually be revoked").toHaveLength(0);

    // Restore through the UI, which is also the appoint path.
    await page.getByLabel("Manager account").selectOption(deputyId);
    await page.getByRole("button", { name: "Appoint as deputy" }).click();
    await expect(page.locator("table tbody tr").filter({ hasText: DEPUTY })).toHaveCount(1);

    const { data: back } = await db
      .from("league_office").select("tier").eq("profile_id", deputyId).single();
    expect(back?.tier).toBe("deputy");
  });

  test("removeStaff refuses an office member, and the row says why", async ({
    page,
  }) => {
    const db = admin();
    const deputyId = await profileIdFor(DEPUTY);
    const { data: league } = await db
      .from("leagues").select("id").eq("slug", "obhl").single();

    // A deputy WITH a membership row — the shape a promoted manager leaves, and
    // the only one where `removeStaff` reaches its office check rather than
    // bouncing off the membership check first.
    await db.from("profile_leagues")
      .insert({ profile_id: deputyId, league_id: league!.id });

    try {
      await signInAs(page, "Manager");
      await page.goto("/obhl/manage/people");

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
      await db.from("profile_leagues")
        .delete().eq("profile_id", deputyId).eq("league_id", league!.id);
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
      email, password: "old-password-000", email_confirm: true,
    });
    const targetId = created!.user!.id;
    await db.from("profiles").upsert({
      id: targetId, role: "scorekeeper", display_name: "Password Target",
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

  test("a deputy is offered no set-password control", async ({ page }) => {
    await signInAs(page, "Deputy");
    await page.goto("/manage/office");
    // On the page, so this is "not offered" rather than "not there at all".
    await expect(page.getByRole("heading", { name: "League Office" })).toBeVisible();
    await expect(page.getByLabel("Staff email")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Set password" })).toHaveCount(0);
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
      email, password: "old-password-000", email_confirm: true,
    });
    const targetId = created!.user!.id;
    await db.from("profiles").upsert({
      id: targetId, role: "scorekeeper", display_name: "Forge Target",
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
        body!.toString("binary").replace("commissioner-pw-1", "forged-by-them-01"),
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
      if (headers["next-action"]) replayHeaders["next-action"] = headers["next-action"];

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
      email, password: "peer-old-pw-000", email_confirm: true,
    });
    const peerId = created!.user!.id;
    // `league_manager` first — 0034's trigger refuses a tier for any other role.
    await db.from("profiles").upsert({
      id: peerId, role: "league_manager", display_name: "Peer Commissioner",
    });
    await db.from("league_office")
      .upsert({ profile_id: peerId, tier: "commissioner" }, { onConflict: "profile_id" });

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
      await db.auth.admin.updateUserById(commissionerId, { password: "hockey123" });
      await db.from("audit_log").delete().eq("entity_id", commissionerId);
      await db.from("audit_log").delete().eq("entity_id", peerId);
      await db.from("league_office").delete().eq("profile_id", peerId);
      await db.from("profiles").delete().eq("id", peerId);
      await db.auth.admin.deleteUser(peerId);
    }
  });
});

/**
 * Path 17: per-league access control — a staff account belongs to leagues
 * (`profile_leagues`), and a role is only usable inside them.
 *
 * The rest of the suite cannot catch this class of bug. It signs in as
 * `manager@obhl.test`, who is a member of every seeded league, so a guard that
 * checks membership and a guard that checks nothing behave identically. Every
 * test here drives an account that belongs to exactly ONE seeded league.
 *
 * Which league that is, this file does not say. Its subject is "a league you
 * belong to" versus "one you do not", and those are roles in the scenario, not
 * particular leagues — so they are derived from the seeded memberships below.
 * Naming them would mean that flipping the seed's confinement leaves every test
 * here navigating to a league the account IS in and expecting a refusal, which
 * then fails for a reason that has nothing to do with the guard under test.
 */
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/** Service-role client, for reading/restoring state the UI can't reach. */
function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** A signed-in ANON-key client — the same access a browser session has. */
async function signedInClient(email: string) {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error } = await client.auth.signInWithPassword({
    email,
    password: "hockey123",
  });
  if (error) throw new Error(`could not sign in as ${email}: ${error.message}`);
  return client;
}

async function leagueId(slug: string) {
  const { data } = await admin().from("leagues").select("id").eq("slug", slug).single();
  return data!.id as string;
}

async function signInAs(
  page: Page,
  label: "Manager" | "One-league mgr" | "One-league scorer",
) {
  await page.goto("/login");
  await page.getByRole("button", { name: label }).click();
  await page.waitForURL("/");
}

/** The leagues a seeded account was actually confined to. */
async function leaguesOf(displayName: string): Promise<string[]> {
  const db = admin();
  const { data: prof } = await db
    .from("profiles")
    .select("id")
    .eq("display_name", displayName)
    .single();
  const { data } = await db
    .from("profile_leagues")
    .select("leagues!inner(slug)")
    .eq("profile_id", prof!.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((r: any) => r.leagues.slug as string);
}

/** The single-league manager's league, and one they are not in. */
let LEAD_IN = "";
let LEAD_OUT = "";
/** The same pair for the single-league scorekeeper. */
let SCORER_IN = "";
let SCORER_OUT = "";

/** The one league an account is confined to — or a failure that names why. */
function theOneLeague(slugs: string[], who: string): string {
  if (slugs.length !== 1) {
    throw new Error(
      `${who} must belong to exactly one league (found ${slugs.length}). ` +
        `Every test in this file derives "a league you are in" from that — see ` +
        `scripts/seed-users.mjs.`,
    );
  }
  return slugs[0];
}

test.beforeAll(async () => {
  const { data: all } = await admin().from("leagues").select("slug");
  const slugs = (all ?? []).map((l) => l.slug as string);
  LEAD_IN = theOneLeague(await leaguesOf("Single League Manager"), "Single League Manager");
  SCORER_IN = theOneLeague(await leaguesOf("Single League Scorer"), "Single League Scorer");
  LEAD_OUT = slugs.find((slug) => slug !== LEAD_IN) ?? "";
  SCORER_OUT = slugs.find((slug) => slug !== SCORER_IN) ?? "";
});

test.describe("Path 17 — Per-league membership", () => {
  test("the fixture still has the shape these tests need", async () => {
    // One clear failure if the seed drifts, instead of a dozen confusing ones
    // spread across every test below.
    // The single-league shape itself is asserted in `beforeAll`, which fails
    // the whole file with the reason rather than letting a bad slug leak into
    // every URL below.
    expect(LEAD_OUT, "need a second league to be refused from").toBeTruthy();
    expect(SCORER_OUT).toBeTruthy();
    // The People & Roles assertions compare two leagues' staff lists, which
    // says nothing unless the two confined accounts sit in different ones.
    expect(SCORER_IN).not.toBe(LEAD_IN);
  });

  // ── The app guards: every manage page under a league you're not in ────────

  test("a manager of one league reaches their own league's tools", async ({
    page,
  }) => {
    // The control for every refusal below: the same account, the same role, a
    // league it belongs to. Without this a guard that refused everything would
    // look like a guard that works.
    await signInAs(page, "One-league mgr");
    await page.goto(`/${LEAD_IN}/manage/dashboard`);
    await expect(page).toHaveURL(`/${LEAD_IN}/manage/dashboard`);
    await expect(page.getByRole("heading", { name: "Manage" })).toBeVisible();

    await page.goto(`/${LEAD_IN}/manage/seasons`);
    await expect(page).toHaveURL(`/${LEAD_IN}/manage/seasons`);
    await expect(page.getByRole("heading", { name: "Seasons" })).toBeVisible();
  });

  // Suffixes, not URLs: the league is prefixed inside the test body, because
  // these tests are generated before `beforeAll` has resolved which league to
  // aim at.
  const MANAGE_PATHS = [
    "/manage/dashboard",
    "/manage/people",
    "/manage/seasons",
    "/manage/rosters",
    "/manage/schedule-builder",
    "/manage/schedule-builder/one-off",
    "/manage/score",
    "/manage/announcements",
    "/manage/rules/edit",
    "/manage/import",
    "/manage/audit",
  ];

  for (const path of MANAGE_PATHS) {
    test(`a manager of another league is refused at ${path}`, async ({ page }) => {
      await signInAs(page, "One-league mgr");
      await page.goto(`/${LEAD_OUT}${path}`);
      // The picker, the same place a wrong ROLE lands — it is the one page that
      // needs no league.
      await expect(page).toHaveURL("/");
    });
  }

  test("a scorekeeper cannot score another league's games", async ({ page }) => {
    // The first leak the handoff names: the role is instance-wide, so a
    // scorekeeper for one league could open the other league's scoresheet and
    // score its games. `/score` is one of only two guards that ever admitted a
    // non-manager role, which is why it gets its own test.
    await signInAs(page, "One-league scorer");
    await page.goto(`/${SCORER_IN}/manage/score`);
    await expect(page.getByRole("heading", { name: "Games" })).toBeVisible();
    const href = await page
      .locator(`a[href^="/${SCORER_IN}/manage/score/"]`)
      .first()
      .getAttribute("href");
    await page.goto(href!);
    await expect(page).toHaveURL(new RegExp(`/${SCORER_IN}/manage/score/`));

    await page.goto(`/${SCORER_OUT}/manage/score`);
    await expect(page).toHaveURL("/");
    // The same game id under a league they are not in — which is what proves
    // the refusal is about the league and not about the page being broken.
    await page.goto(href!.replace(`/${SCORER_IN}/`, `/${SCORER_OUT}/`));
    await expect(page).toHaveURL("/");
  });

  test("a game in another league is not scoreable", async ({ page }) => {
    // Detail pages take an id, and the id says nothing about its league; the
    // slug in the URL is the claim, and the guard is what checks it.
    await signInAs(page, "Manager");
    await page.goto(`/${LEAD_OUT}/manage/score`);
    const href = await page
      .locator(`a[href^="/${LEAD_OUT}/manage/score/"]`)
      .first()
      .getAttribute("href");

    await signInAs(page, "One-league mgr");
    await page.goto(href!);
    await expect(page).toHaveURL("/");
  });

  test("the switcher offers only the leagues the account belongs to", async ({
    page,
  }) => {
    // A manager of two leagues gets a switcher; a manager of one gets none,
    // because it renders nothing below two options. Offering a league whose
    // pages then bounce you back to the picker is worse than not offering it.
    await signInAs(page, "Manager");
    await page.goto(`/${LEAD_OUT}/manage/dashboard`);
    await expect(page.getByLabel("Select league")).toHaveCount(1);

    await signInAs(page, "One-league mgr");
    await page.goto(`/${LEAD_IN}/manage/dashboard`);
    await expect(page.getByLabel("Select league")).toHaveCount(0);
  });

  // ── People & Roles is this league's staff, and Remove is not a delete ─────

  test("People & Roles lists this league's staff only", async ({ page }) => {
    await signInAs(page, "Manager");

    // `exact` throughout. These assertions are about which addresses are
    // ABSENT, and a substring match finds an address that is not there — which
    // reads as exactly the leak this test exists to catch.
    const cell = (p: Page, email: string) =>
      p.getByRole("cell", { name: email, exact: true });

    await page.goto(`/${LEAD_IN}/manage/people`);
    await expect(cell(page, "single-league-lead@obhl.test")).toBeVisible();
    await expect(cell(page, "manager@obhl.test")).toBeVisible();

    // The same page under a league they are not staff of: not listed there,
    // and so not editable or removable there either.
    await page.goto(`/${SCORER_IN}/manage/people`);
    await expect(cell(page, "manager@obhl.test")).toBeVisible();
    await expect(cell(page, "single-league-scorer@obhl.test")).toBeVisible();
    await expect(cell(page, "single-league-lead@obhl.test")).toHaveCount(0);

    // …and the mirror image, so neither list is merely the whole table.
    await page.goto(`/${LEAD_IN}/manage/people`);
    await expect(cell(page, "single-league-scorer@obhl.test")).toHaveCount(0);
  });

  test("Remove takes a person out of this league and leaves the account", async ({
    page,
  }) => {
    const scorekeeper = "scorekeeper@obhl.test";
    const from = await leagueId(LEAD_OUT);
    const db = admin();
    const memberships = async () => {
      const { data: prof } = await db
        .from("profiles")
        .select("id, display_name")
        .eq("display_name", "Score Keeper")
        .single();
      const { data } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", prof!.id);
      return { id: prof!.id, leagues: (data ?? []).map((r) => r.league_id) };
    };

    const before = await memberships();
    expect(before.leagues).toContain(from);

    try {
      await signInAs(page, "Manager");
      await page.goto(`/${LEAD_OUT}/manage/people`);
      await page
        .locator("table tbody tr")
        .filter({ hasText: scorekeeper })
        .getByRole("button", { name: "Remove" })
        .click();
      await expect(page.getByText(scorekeeper)).toHaveCount(0);

      // Gone from THIS league only. Removing used to call
      // auth.admin.deleteUser, which does not come back.
      const after = await memberships();
      expect(after.id).toBe(before.id);
      expect(after.leagues).not.toContain(from);
      expect(after.leagues.length).toBe(before.leagues.length - 1);

      await page.goto(`/${LEAD_IN}/manage/people`);
      await expect(page.getByText(scorekeeper)).toBeVisible();
    } finally {
      await db
        .from("profile_leagues")
        .upsert(
          { profile_id: before.id, league_id: from },
          { onConflict: "profile_id,league_id" },
        );
    }
  });

  test("adding an existing account cannot rewrite the role it holds elsewhere", async ({
    page,
  }) => {
    // "Add a staff account" reaches an account that already exists: createUser
    // fails on a known address, the id is looked up, and the profile is then
    // upserted. `profiles.role` is ONE instance-wide column (0009 reads it as
    // the role source; 0010's hook copies it into the JWT), so that upsert
    // rewrites the role the account uses in EVERY league it belongs to.
    //
    // The victim here belongs only to a league this manager is not in, and the
    // fixture test above asserts those two leagues differ. Granting them
    // `league_manager` therefore makes them a manager of a league the actor
    // cannot reach — through the ordinary form, with no tampering.
    //
    // createStaffAccount is the one action in people.ts that never calls
    // `isMemberOf`; updateStaffRole and removeStaff both do.
    const victim = "single-league-scorer@obhl.test";
    const db = admin();
    const outsideLeague = await leagueId(LEAD_IN);

    const { data: before } = await db
      .from("profiles")
      .select("id, role, display_name")
      .eq("display_name", "Single League Scorer")
      .single();
    // State the precondition rather than assume it: if the seed ever makes this
    // account a manager, the upsert below is a no-op and the test would pass
    // while proving nothing.
    expect(before!.role, "victim must start as a non-manager").toBe("scorekeeper");

    const memberships = async () => {
      const { data } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", before!.id);
      return (data ?? []).map((r) => r.league_id as string);
    };
    expect(await memberships()).not.toContain(outsideLeague);

    try {
      await signInAs(page, "One-league mgr");
      await page.goto(`/${LEAD_IN}/manage/people`);

      const card = page
        .locator('[data-slot="card"]')
        .filter({ hasText: "Add a staff account" });
      await card.getByLabel("Email").fill(victim);
      // Their own display name, so the blast radius of a passing-today run is
      // the role alone. Left blank this field defaults to the email address and
      // overwrites the column that `beforeAll` derives the fixture from.
      await card.getByLabel("Display name").fill(before!.display_name!);
      await card.getByRole("combobox").click();
      await page.getByRole("option", { name: "League manager" }).click();
      await submitAndSettle(
        page,
        card.getByRole("button", { name: "Add staff account" }).click(),
      );

      // The refusal is VISIBLE, and asserted before the database checks. The
      // two below can both hold on a form that never submitted at all, which
      // would make this test pass while proving nothing once the guard lands —
      // the inverse of the vacuous-pass trap described above.
      //
      // Which refusal: the victim holds `scorekeeper` and this form submits
      // `league_manager`, so the role-mismatch branch answers first and the
      // `mayWriteProfileOf` check below it never runs. That one is the narrower
      // second layer — it decides only the case where an existing login has no
      // role to compare against — so naming its message here asserted a guard
      // this fixture cannot reach, while the escalation was in fact refused.
      await expect(
        card.getByText(/already has an account as scorekeeper/),
      ).toBeVisible();

      // The subject of the test: a manager of one league changed what an
      // account is allowed to do in another.
      //
      // Soft, both of them, so a failing run reports the whole effect rather
      // than stopping at the first half of it.
      const { data: after } = await db
        .from("profiles")
        .select("role")
        .eq("id", before!.id)
        .single();
      expect
        .soft(
          after!.role,
          "a manager of another league rewrote this account's global role",
        )
        .toBe("scorekeeper");

      // And did not hand themselves the membership either.
      expect
        .soft(await memberships(), "…and granted it their own league")
        .not.toContain(outsideLeague);
    } finally {
      await db
        .from("profiles")
        .update({ role: before!.role, display_name: before!.display_name })
        .eq("id", before!.id);
      await db
        .from("profile_leagues")
        .delete()
        .eq("profile_id", before!.id)
        .eq("league_id", outsideLeague);
    }
  });

  test("a manager cannot change the role of someone who works a league they don't share", async ({
    page,
  }) => {
    // The SECOND step of the same escalation, and the reason refusing the
    // profile write above does not close it.
    //
    // Step one is permitted on purpose: adding an existing account at the role
    // it already holds grants membership and touches no profile — that is how
    // one person works two leagues. But it also makes the actor share a league
    // with them, so `isMemberOf` then passes in `updateStaffRole`, and
    // `profiles.role` is instance-wide, so whatever that writes lands in the
    // league the actor cannot see.
    //
    // BOTH directions are driven, because the column does not care which way it
    // is pointed: `league_manager`, which hands the victim authority in their
    // own league, and `captain`, which takes their scorekeeping there away.
    // Neither is this manager's to decide, and a guard that only watches for
    // promotions lets the second one through.
    //
    // `mayWriteProfileOf` tests CONTAINMENT for exactly this reason. An overlap
    // test cannot catch it — step one creates the very sharing it looks for —
    // and neither can RLS: 0032's `shares_league_with(id)` permits the
    // identical sequence for the identical reason.
    const victim = "single-league-scorer@obhl.test";
    // Its own address, sharing no substring with a seeded one — see
    // `scripts/seed-users.mjs` on why that matters to a `hasText` row filter.
    const decoyEmail = `role-decoy-${Date.now()}@obhl.test`;
    const db = admin();
    const shared = await leagueId(LEAD_IN);
    const theirs = await leagueId(SCORER_IN);

    const { data: before } = await db
      .from("profiles")
      .select("id, role, display_name")
      .eq("display_name", "Single League Scorer")
      .single();
    expect(before!.role, "victim must start as a non-manager").toBe("scorekeeper");

    /** The add form, filled and submitted, on a page fresh enough to fill. */
    async function addStaff(email: string, name: string, roleLabel: string) {
      await page.goto(`/${LEAD_IN}/manage/people`);
      const card = page
        .locator('[data-slot="card"]')
        .filter({ hasText: "Add a staff account" });
      await card.getByLabel("Email").fill(email);
      await card.getByLabel("Display name").fill(name);
      await card.getByRole("combobox").click();
      await page.getByRole("option", { name: roleLabel }).click();
      await submitAndSettle(
        page,
        card.getByRole("button", { name: "Add staff account" }).click(),
      );
      return card;
    }

    let decoyId: string | null = null;
    try {
      await signInAs(page, "One-league mgr");

      // ── Step 1: the permitted grant ──────────────────────────────────────
      //
      // Their own display name: the add form writes no profile on this path,
      // but leaving it blank would default the column to the email address that
      // `beforeAll` derives the whole fixture from.
      const card = await addStaff(victim, before!.display_name!, "Scorekeeper");
      // Asserted, not assumed. If step one were refused, step two would be
      // refused for THAT reason and this test would prove nothing.
      await expect(card.getByText(/now works this league too/)).toBeVisible();

      // ── Step 2: the page offers no way to spend it ───────────────────────
      await page.reload();
      const row = page.locator("table tbody tr").filter({ hasText: victim });
      await expect(row, "the grant should have put them in this table").toHaveCount(1);
      await expect(
        row.getByLabel("Change role"),
        "no role on this row is a manager of one league's to change",
      ).toHaveCount(0);
      await expect(row.getByText("Also works another league")).toBeVisible();

      // ── Step 3: and the server refuses it without the page's help ────────
      //
      // Withholding the control is a courtesy to the manager, not a control on
      // the request. So the attack needs a row this manager may still edit, and
      // the only kind left is one whose leagues are all theirs — an account
      // created here and nowhere else. It exists to carry the tampered id.
      await addStaff(decoyEmail, "Role Decoy", "Scorekeeper");
      const { data: decoy } = await db
        .from("profiles")
        .select("id")
        .eq("display_name", "Role Decoy")
        .single();
      decoyId = decoy!.id as string;

      for (const forged of ["league_manager", "captain"] as const) {
        await page.goto(`/${LEAD_IN}/manage/people`);
        const decoyRow = page
          .locator("table tbody tr")
          .filter({ hasText: decoyEmail });
        // By the select, not by `league_id` — Remove carries that too, and this
        // row, unlike a manager's, renders both forms.
        const form = decoyRow.locator("form").filter({
          has: page.locator('select[name="role"]'),
        });
        // The decoy's own id would be a PERMITTED change, so an unapplied
        // tamper rewrites the decoy, leaves the victim alone, and passes every
        // check below without the attack ever happening. See `tamper`.
        await tamper(page, form.locator('input[name="id"]'), before!.id);
        await submitAndSettle(
          page,
          form.locator('select[name="role"]').selectOption(forged),
        );

        // Soft, so a failing run reports both halves rather than the first.
        const { data: after } = await db
          .from("profiles")
          .select("role")
          .eq("id", before!.id)
          .single();
        expect
          .soft(
            after!.role,
            `a manager of one league wrote ${forged} into an account working another`,
          )
          .toBe("scorekeeper");
        // …and the POST carried the tampered id rather than the decoy's own,
        // which is what makes the line above mean anything.
        const { data: decoyAfter } = await db
          .from("profiles")
          .select("role")
          .eq("id", decoyId)
          .single();
        expect
          .soft(decoyAfter!.role, "the tamper did not reach the server")
          .toBe("scorekeeper");
      }

      // Refusing the change must not cost them the league they came from.
      const { data: still } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", before!.id);
      expect((still ?? []).map((r) => r.league_id)).toContain(theirs);
    } finally {
      await db
        .from("profiles")
        .update({ role: before!.role, display_name: before!.display_name })
        .eq("id", before!.id);
      await db
        .from("profile_leagues")
        .delete()
        .eq("profile_id", before!.id)
        .eq("league_id", shared);
      // The decoy is this test's own litter. Deleting the login takes the
      // profile and its membership with it — both cascade.
      if (decoyId) await db.auth.admin.deleteUser(decoyId);
    }
  });

  test("a manager can still promote someone whose leagues they all share", async ({
    page,
  }) => {
    // The control for the test above. `mayWriteProfileOf` refusing every role
    // change would satisfy that one exactly as well as a correct guard does,
    // and handing a second person a manager account is the flow the whole
    // membership model exists to support — so it has to be shown working.
    //
    // Both accounts here are seeded into every league, so containment holds and
    // the promotion reaches no league the actor is not already a manager of.
    const subject = "scorekeeper@obhl.test";
    const db = admin();

    const { data: before } = await db
      .from("profiles")
      .select("id, role")
      .eq("display_name", "Score Keeper")
      .single();
    expect(before!.role, "control subject must start as a non-manager").toBe(
      "scorekeeper",
    );

    try {
      await signInAs(page, "Manager");
      await page.goto(`/${LEAD_IN}/manage/people`);

      const row = page.locator("table tbody tr").filter({ hasText: subject });
      const select = row.getByLabel("Change role");
      // Rendered at all here, unlike the row in the test above, and with the
      // manager option on it.
      await expect(
        select.locator('option[value="league_manager"]'),
      ).toHaveCount(1);

      await submitAndSettle(page, select.selectOption("league_manager"));

      const { data: after } = await db
        .from("profiles")
        .select("role")
        .eq("id", before!.id)
        .single();
      expect(after!.role, "the permitted promotion was refused too").toBe(
        "league_manager",
      );
    } finally {
      await db
        .from("profiles")
        .update({ role: before!.role })
        .eq("id", before!.id);
    }
  });

  // ── The other half: RLS, for a session talking to PostgREST directly ──────
  //
  // The app guards gate the UI. A staff account also holds a real Supabase
  // session, and can address the API with it without going through a page at
  // all — so the same membership test has to live in the policies (0032), or
  // the app half would look finished and stop nothing.

  test("a session cannot write another league's rows through the API", async () => {
    const client = await signedInClient("single-league-lead@obhl.test");
    const db = admin();

    const { data: foreign } = await db
      .from("seasons")
      .select("id, name, league_id")
      .eq("league_id", await leagueId(LEAD_OUT))
      .limit(1)
      .single();

    // An RLS-filtered UPDATE is not an error — it simply matches no rows. The
    // `select()` is what makes the difference observable.
    const { data: updated } = await client
      .from("seasons")
      .update({ name: "Hijacked" })
      .eq("id", foreign!.id)
      .select("id");
    expect(updated ?? []).toHaveLength(0);

    const { data: check } = await db
      .from("seasons")
      .select("name")
      .eq("id", foreign!.id)
      .single();
    expect(check!.name).toBe(foreign!.name);

    // Inserting into another league is refused outright by the WITH CHECK.
    const { error: insErr } = await client
      .from("announcements")
      .insert({ league_id: foreign!.league_id, title: "Hijack", body: "no" });
    expect(insErr).not.toBeNull();

    await client.auth.signOut();
  });

  test("a session cannot mint a manager of another league through the API", async () => {
    // The API half of "a manager cannot change the role of someone who works a
    // league they don't share". The app guard runs in a server action, and a
    // staff account holds a real Supabase session that never has to go near one
    // — so the same test has to live in the policies (0033), or the app half
    // would look finished and stop nothing.
    //
    // Both steps were watched succeeding here before that migration existed.
    const db = admin();
    const shared = await leagueId(LEAD_IN);
    const { data: victim } = await db
      .from("profiles")
      .select("id, role")
      .eq("display_name", "Single League Scorer")
      .single();
    expect(victim!.role, "victim must start as a non-manager").toBe("scorekeeper");

    const client = await signedInClient("single-league-lead@obhl.test");
    try {
      // Step 1 is PERMITTED, and asserted so. Granting someone a league you
      // manage is the flow the membership model exists for — and if it were
      // refused, step 2 would fail for that reason and prove nothing.
      const granted = await client
        .from("profile_leagues")
        .insert({ profile_id: victim!.id, league_id: shared })
        .select();
      expect(
        granted.error,
        "granting a league you manage should still be allowed",
      ).toBeNull();

      // Step 2 is the escalation: `profiles.role` is instance-wide, so this
      // would make them a manager of the league they actually work, which this
      // caller is not in.
      await client
        .from("profiles")
        .update({ role: "league_manager" })
        .eq("id", victim!.id);

      // Read the ROW, not the error. An RLS-refused UPDATE matches no rows and
      // reports no error at all, so asserting on `error` would pass whether the
      // policy is there or not.
      const { data: after } = await db
        .from("profiles")
        .select("role")
        .eq("id", victim!.id)
        .single();
      expect(
        after!.role,
        "a session minted a manager of a league it cannot reach",
      ).toBe("scorekeeper");
    } finally {
      await client.auth.signOut();
      await db.from("profiles").update({ role: victim!.role }).eq("id", victim!.id);
      await db
        .from("profile_leagues")
        .delete()
        .eq("profile_id", victim!.id)
        .eq("league_id", shared);
    }
  });

  test("a session can still write its OWN league's rows through the API", async () => {
    // The other side of the previous test: policies that refuse everything
    // would pass it, and this is what says they don't.
    const client = await signedInClient("single-league-lead@obhl.test");
    const db = admin();

    const { data: own } = await db
      .from("seasons")
      .select("id, name")
      .eq("league_id", await leagueId(LEAD_IN))
      .limit(1)
      .single();

    try {
      const { data: updated, error } = await client
        .from("seasons")
        .update({ name: own!.name })
        .eq("id", own!.id)
        .select("id");
      expect(error).toBeNull();
      expect(updated ?? []).toHaveLength(1);
    } finally {
      await db.from("seasons").update({ name: own!.name }).eq("id", own!.id);
      await client.auth.signOut();
    }
  });

  test("the audit log of another league is not readable through the API", async () => {
    const client = await signedInClient("single-league-lead@obhl.test");
    const theirs = await leagueId(LEAD_OUT);

    // Reverting an audit entry is a write — it reopens games and restores
    // player status — so who can READ the log is who can undo the league.
    const { count } = await client
      .from("audit_log")
      .select("*", { count: "exact", head: true })
      .eq("league_id", theirs);
    expect(count ?? 0).toBe(0);

    await client.auth.signOut();
  });

  test("another league's staff are not readable through the API", async () => {
    // People & Roles reads profiles on the admin client, so this is the
    // policy's own half: a session asking directly sees only accounts it
    // shares a league with.
    const client = await signedInClient("single-league-lead@obhl.test");
    const db = admin();

    const { data: rows } = await client.from("profiles").select("id");
    const visible = new Set((rows ?? []).map((r) => r.id));

    const { data: sharedMembers } = await db
      .from("profile_leagues")
      .select("profile_id")
      .eq("league_id", await leagueId(LEAD_IN));
    const allowed = new Set((sharedMembers ?? []).map((r) => r.profile_id));

    expect(visible.size).toBeGreaterThan(0);
    for (const id of visible) expect(allowed.has(id)).toBe(true);

    // Named explicitly: the set check above cannot fail while every seeded
    // account happens to share a league with this one, and this is the account
    // that does not.
    const { data: outsider } = await db
      .from("profiles")
      .select("id")
      .eq("display_name", "Single League Scorer")
      .single();
    expect(visible.has(outsider!.id)).toBe(false);

    await client.auth.signOut();
  });
  // ── Server actions, reached with another league's id ──────────────────────
  //
  // The gap the first version of this file could not cover. A manage form
  // carries its ids as hidden inputs, so rewriting one and submitting goes
  // through the genuine action endpoint — no hand-made POST and no action id
  // needed — which is the only way an action's guard gets exercised against an
  // id the UI would never offer it.
  //
  // Both run as `Manager`, who belongs to BOTH leagues on purpose: that is the
  // case a per-id membership check cannot catch, because each id passes on its
  // own and only the requirement that they name the SAME league refuses it.

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
   * Point a hidden form field at something the server must refuse, and prove it
   * took before anyone submits.
   *
   * Setting `.value` on a React-rendered input before hydration lands is undone
   * when React takes over, and the form then posts its ORIGINAL value. Both ways
   * that can go have now been seen on CI and neither on a laptop, where
   * hydration always wins the race:
   *
   *  - where the original value is forbidden too, the action is refused for the
   *    wrong reason, or not at all, and the test fails somewhere confusing;
   *  - where the original value is PERMITTED — a co-manager's own Remove — the
   *    action quietly succeeds and the test passes without the attack ever
   *    happening. That one is the dangerous half: it proves nothing and says so
   *    nowhere.
   *
   * So settle, set, and assert. Never submit an unverified tamper.
   */
  async function tamper(page: Page, field: Locator, value: string) {
    await page.waitForLoadState("networkidle");
    await field.evaluate((el, v) => ((el as HTMLInputElement).value = v), value);
    await expect(field).toHaveValue(value);
  }

  /** Roster rows whose team and season belong to different leagues — always 0. */
  async function crossLeagueRosterRows(db: ReturnType<typeof admin>) {
    const { data } = await db
      .from("team_players")
      .select("id, teams!team_players_team_id_fkey!inner(league_id), seasons!inner(league_id)");
    return (data ?? []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r: any) => r.teams?.league_id !== r.seasons?.league_id,
    ).length;
  }

  /** A roster page in the league whose form the test will tamper with. */
  async function teamRosterUrl(page: Page, slug: string) {
    await page.goto(`/${slug}/manage/rosters`);
    const href = await page
      .locator(`a[href^="/${slug}/manage/rosters/"]`)
      .first()
      .getAttribute("href");
    return href!;
  }

  test("a roster add cannot name another league's team", async ({ page }) => {
    const db = admin();
    const { data: foreignTeam } = await db
      .from("teams")
      .select("id, name")
      .eq("league_id", await leagueId(LEAD_OUT))
      .limit(1)
      .single();

    const first = `Smuggled${Date.now()}`;
    try {
      await signInAs(page, "Manager");
      await page.goto(await teamRosterUrl(page, LEAD_IN));

      const form = page.locator("form").filter({
        has: page.locator('input[name="first_name"]'),
      });
      // The season stays the page's own; only the team is swapped. Guarding
      // the season alone passed this, and `is_captain` rides in the same
      // payload.
      await tamper(page, form.locator('input[name="team_id"]'), foreignTeam!.id);
      await form.getByLabel("First name").fill(first);
      await form.getByLabel("Last name").fill("Player");
      await submitAndSettle(
        page,
        form.getByRole("button", { name: "Add player" }).click(),
      );

      // The refusal itself, asserted first: the guard redirects to the picker,
      // and unlike the DB checks below this one WAITS, so it fails loudly
      // rather than reading a write that has not landed yet.
      await expect(page).toHaveURL("/");

      // Nothing was written — not the roster row, and not even the player, since
      // the guard runs before the insert that would create one.
      const { data: players } = await db
        .from("players")
        .select("id")
        .eq("first_name", first);
      expect(players ?? []).toHaveLength(0);

      // A cross-league roster row is nonsense the schema cannot refuse on its
      // own: the two foreign keys are independent, so nothing but this guard
      // stops one league's team being rostered into another's season.
      expect(await crossLeagueRosterRows(db)).toBe(0);
    } finally {
      const { data: junk } = await db
        .from("players")
        .select("id")
        .eq("first_name", first);
      for (const p of junk ?? []) await db.from("players").delete().eq("id", p.id);
    }
  });

  test("setting a default goalie cannot name another league's roster row", async ({
    page,
  }) => {
    const db = admin();
    // Selected through the TEAM's league, not through whichever season happens
    // to be active — earlier specs in the suite move that around, and all this
    // row has to be is another league's.
    const { data: victim } = await db
      .from("team_players")
      .select("id, is_default_goalie, teams!team_players_team_id_fkey!inner(league_id)")
      .eq("teams.league_id", await leagueId(LEAD_OUT))
      .eq("is_default_goalie", false)
      .limit(1)
      .single();
    expect(victim, "no foreign roster row to aim at").not.toBeNull();

    try {
      await signInAs(page, "Manager");
      await page.goto(await teamRosterUrl(page, LEAD_IN));

      // The one form carrying id + team_id + season_id + make is setDefaultGoalie.
      const form = page
        .locator("form")
        .filter({ has: page.locator('input[name="season_id"]') })
        .filter({ has: page.locator('input[name="make"]') })
        .first();
      await tamper(page, form.locator('input[name="id"]'), victim!.id);
      await tamper(page, form.locator('input[name="make"]'), "1");
      await submitAndSettle(page, form.getByRole("button").first().click());
      await expect(page).toHaveURL("/");

      // The clear that runs first is bounded by team+season and was never the
      // risk; this is the write keyed on the id alone.
      const { data: after } = await db
        .from("team_players")
        .select("is_default_goalie")
        .eq("id", victim!.id)
        .single();
      expect(after!.is_default_goalie).toBe(false);
    } finally {
      await db
        .from("team_players")
        .update({ is_default_goalie: false })
        .eq("id", victim!.id);
    }
  });

  test("clearing a default goalie cannot name another league's roster row", async ({
    page,
  }) => {
    // The same form with `make` flipped to 0. That path writes nothing keyed on
    // the id — but `logAudit` uses it regardless, on the admin client, so
    // guarding only the table writes let an unset file an entry against another
    // league's roster row, in that league's audit log.
    const db = admin();
    const { data: victim } = await db
      .from("team_players")
      .select("id, teams!team_players_team_id_fkey!inner(league_id)")
      .eq("teams.league_id", await leagueId(LEAD_OUT))
      .limit(1)
      .single();

    await signInAs(page, "Manager");
    await page.goto(await teamRosterUrl(page, LEAD_IN));

    const form = page
      .locator("form")
      .filter({ has: page.locator('input[name="season_id"]') })
      .filter({ has: page.locator('input[name="make"]') })
      .first();
    await tamper(page, form.locator('input[name="id"]'), victim!.id);
    await tamper(page, form.locator('input[name="make"]'), "0");
    await submitAndSettle(page, form.getByRole("button").first().click());
    await expect(page).toHaveURL("/");

    const { data: planted } = await db
      .from("audit_log")
      .select("id")
      .eq("entity_id", victim!.id)
      .eq("action", "set_default_goalie");
    expect(planted ?? []).toHaveLength(0);
  });

  // ── A second manager can be taken back out of a league ────────────────────

  test("a manager can be removed from a league, but never yourself", async ({
    page,
  }) => {
    const db = admin();
    const mine = await leagueId(LEAD_IN);
    const { data: target } = await db
      .from("profiles")
      .select("id")
      .eq("display_name", "Single League Manager")
      .single();
    const { data: self } = await db
      .from("profiles")
      .select("id")
      .eq("display_name", "League Manager")
      .single();

    try {
      await signInAs(page, "Manager");
      await page.goto(`/${LEAD_IN}/manage/people`);

      // Your own row offers no Remove — it could drop you out of a league you
      // are the only way back into, and for a league's sole manager that row is
      // always this one.
      const ownRow = page
        .locator("table tbody tr")
        .filter({ hasText: "manager@obhl.test" });
      await expect(ownRow.getByRole("button", { name: "Remove" })).toHaveCount(0);

      // …and the page not offering it is not the guard. Aim a real Remove form
      // at yourself and submit: the server has to be what refuses.
      const coRow = page
        .locator("table tbody tr")
        .filter({ hasText: "single-league-lead@obhl.test" });
      const removeForm = coRow.locator("form").filter({
        has: page.locator('input[name="league_id"]'),
      });
      // The original id here is a PERMITTED removal, so an unapplied tamper
      // removes the co-manager for real and the "still a member" check below
      // passes without the attack happening. See `tamper`.
      await tamper(page, removeForm.locator('input[name="id"]'), self!.id);

      await submitAndSettle(
        page,
        removeForm.getByRole("button", { name: "Remove" }).click(),
      );
      // The co-manager must still be here — proof the POST carried the tampered
      // id and was refused, not the original id and quietly honoured.
      await expect(
        page.getByRole("cell", {
          name: "single-league-lead@obhl.test",
          exact: true,
        }),
      ).toHaveCount(1);
      const { data: stillMine } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", self!.id)
        .eq("league_id", mine);
      expect(stillMine ?? []).toHaveLength(1);

      // The co-manager's row IS removable — that is how a second manager
      // account gets taken back.
      await page.goto(`/${LEAD_IN}/manage/people`);
      const row = page
        .locator("table tbody tr")
        .filter({ hasText: "single-league-lead@obhl.test" });
      await expect(row.getByText("Role changed by hand")).toBeVisible();
      await expect(row.getByLabel("Change role")).toHaveCount(0);
      await submitAndSettle(
        page,
        row.getByRole("button", { name: "Remove" }).click(),
      );

      await expect(
        page.getByRole("cell", { name: "single-league-lead@obhl.test", exact: true }),
      ).toHaveCount(0);

      // The league went, the account did not.
      const { data: stillThere } = await db
        .from("profiles")
        .select("id, role")
        .eq("id", target!.id)
        .single();
      expect(stillThere!.role).toBe("league_manager");
      const { data: left } = await db
        .from("profile_leagues")
        .select("league_id")
        .eq("profile_id", target!.id);
      expect(left ?? []).toHaveLength(0);
    } finally {
      await db
        .from("profile_leagues")
        .upsert(
          { profile_id: target!.id, league_id: mine },
          { onConflict: "profile_id,league_id" },
        );
    }
  });
});

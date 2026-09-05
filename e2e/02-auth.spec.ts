/**
 * Path 6: Auth — login and session management.
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

/**
 * Rewrite a hidden input, then PROVE it stuck before submitting.
 *
 * The same helper and the same reason as `16-league-membership.spec.ts`: setting
 * `.value` before hydration lands is undone when React takes over, and the form
 * posts its original value — so on a slow runner the tamper never happened and
 * the test passes for the wrong reason.
 */
async function tamper(page: Page, field: Locator, value: string) {
  await page.waitForLoadState("networkidle");
  await field.evaluate((el, v) => ((el as HTMLInputElement).value = v), value);
  await expect(field).toHaveValue(value);
}

/**
 * The access token the browser is actually holding, decoded.
 *
 * `@supabase/ssr` writes the session as `sb-<host-head>-auth-token`, base64url
 * behind a `base64-` prefix, split into `.0`/`.1` chunks past 3180 bytes. All of
 * that is reassembled here for ONE assertion — that the token carries no role
 * claim — because a probe that assumes the claim is missing is a probe that
 * proves nothing when it is present.
 */
async function accessTokenClaims(page: Page) {
  const base = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0]}-auth-token`;
  const cookies = (await page.context().cookies())
    .filter((c) => c.name === base || c.name.startsWith(`${base}.`))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (cookies.length === 0)
    throw new Error(`no ${base} cookie — is the session set?`);
  const joined = cookies.map((c) => c.value).join("");
  const raw = joined.startsWith("base64-")
    ? Buffer.from(joined.slice("base64-".length), "base64url").toString()
    : decodeURIComponent(joined);
  const token = JSON.parse(raw).access_token as string;
  return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()) as {
    sub: string;
    app_metadata?: { role?: string };
  };
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

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("/login");
}

test.describe("Path 6 — Auth / Login / Session", () => {
  test("dev quick sign-in lands on the league picker, not a dead /dashboard", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Manager" }).click();
    await page.waitForURL("/");
    await expect(
      page.getByRole("heading", { name: "Choose your league" }),
    ).toBeVisible();
  });

  test("the manage dashboard shows the manager's tools", async ({ page }) => {
    await signedInAs(page, "Manager");
    await expect(page.getByRole("heading", { name: "Manage" })).toBeVisible();
    await expect(page.getByText("People & Roles").first()).toBeVisible();
    await expect(page.getByText("Seasons").first()).toBeVisible();
  });

  test("sign out returns to /login", async ({ page }) => {
    await signedInAs(page, "Manager");
    await signOut(page);
    await expect(page).toHaveURL("/login");
    await expect(
      page.getByRole("heading", { name: "Staff sign in" }),
    ).toBeVisible();
  });

  test("unauthenticated access to a manage route redirects to /login", async ({
    page,
  }) => {
    await page.goto("/obhl/seasons");
    await expect(page).toHaveURL(/\/login/);
  });

  test("scorekeeper dashboard shows Score Games card but not People & Roles", async ({
    page,
  }) => {
    await signedInAs(page, "Scorekeeper");
    await expect(page.getByText("Score Games").first()).toBeVisible();
    // People & Roles card should not appear on a scorekeeper dashboard
    const peopleCard = page.locator('[data-slot="card-title"]', {
      hasText: "People & Roles",
    });
    await expect(peopleCard).not.toBeVisible();
  });

  test("captain dashboard shows team card", async ({ page }) => {
    await signedInAs(page, "Captain");
    await expect(page.getByText(/captain the/i)).toBeVisible();
  });
});

/**
 * The role badge specifically, not the word anywhere on the page. As a bare
 * `getByText("Manager")` this matched any future content containing the word —
 * a staff name, an announcement — so the absence assertions below would have
 * started failing on unrelated copy.
 */
const badge = (page: Page) =>
  page.locator('[data-slot="badge"]', { hasText: "Manager" });

/**
 * The chrome outside the manage tools. A signed-in manager used to see exactly
 * what a stranger saw on every public page — no badge, no route to their tools,
 * no way out — which is the confusion the account cluster exists to end.
 */
test.describe("Path 6b — Auth-aware chrome", () => {
  test("a signed-in manager carries their badge onto the public site", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Manager" }).click();
    await page.waitForURL("/");

    // The picker: the page sign-in actually lands on, and the one page with no
    // league in its URL.
    await expect(badge(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.getByRole("link", { name: "Manage" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    // And a public league page, which has its own header — plus, for a manager,
    // the staff link row beneath it, so the merged pages are not a dead end.
    await page.goto("/obhl/standings");
    await expect(badge(page)).toBeVisible();
    const staff = page.getByRole("navigation", { name: "Staff tools" });
    await expect(staff).toBeVisible();
    await expect(staff.getByRole("link", { name: "Seasons" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Manage" })).toHaveAttribute(
      "href",
      "/obhl/dashboard",
    );
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("an anonymous visitor sees none of it", async ({ page }) => {
    for (const url of ["/", "/obhl/standings"]) {
      await page.goto(url);
      await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(
        0,
      );
      await expect(page.getByRole("link", { name: "Manage" })).toHaveCount(0);
      await expect(badge(page)).toHaveCount(0);
      await expect(
        page.getByRole("navigation", { name: "Staff tools" }),
      ).toHaveCount(0);
    }
  });

  test("the public header does not overflow at md, signed in or out", async ({
    page,
  }) => {
    // `md` is where the inline nav appears and where the bar has always been at
    // its tightest — see the measurement in `site-header.tsx`. Signed in the
    // links drop to their own row instead of sharing it with the account
    // controls, which is what keeps this true.
    //
    // Measured on the BAR, not on the document. The document is the weaker
    // subject: `NavLinks` carries `overflow-x-auto`, and an overflowing flex
    // item with its own scroller can absorb the excess by clipping its links
    // rather than pushing the page sideways — which is the mechanism
    // `manage-nav.tsx` documents. The bar's own `scrollWidth` sees the overflow
    // either way.
    //
    // Controlled 2026-09-05: with the signed-in class strings reverted to `md:`,
    // this fails on the signed-in leg. It is not a check that cannot fail.
    //
    // ⚠️ The ANONYMOUS leg has no such demonstration, and cannot easily have one:
    // anonymous is the state the layout was already sized for, so there is no
    // edit that makes it overflow without changing what it is testing. Read it as
    // a regression guard on a measured-good state, not as a proven-sensitive
    // assertion.
    // Three subjects, because each can absorb what the one above it would show.
    // The document is the weakest: the bar can overflow while the page does not.
    // The bar is stronger, but `NavLinks` is an `overflow-x-auto` scroller, and a
    // scroll container contributes zero min-content — so its wrapper can shrink
    // to nothing and CLIP THE LINKS while the bar still reports no overflow.
    // Asserting on the nav's own scroller is what closes that, and it is the
    // mechanism `manage-nav.tsx` documents.
    const fits = () =>
      page.evaluate(() => {
        const bar = document.querySelector("header > div");
        if (!bar) throw new Error("header bar not found");
        const nav = document.querySelector("header nav");
        if (!nav) throw new Error("header nav not found");
        return (
          bar.scrollWidth <= bar.clientWidth &&
          nav.scrollWidth <= nav.clientWidth &&
          document.documentElement.scrollWidth <=
            document.documentElement.clientWidth
        );
      });

    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto("/obhl/standings");
    expect(await fits()).toBe(true);

    await page.goto("/login");
    await page.getByRole("button", { name: "Manager" }).click();
    await page.waitForURL("/");
    await page.goto("/obhl/standings");
    expect(await fits()).toBe(true);
    await expect(badge(page)).toBeVisible();
  });
});
/**
 * Path 6b: the role LOCKOUT — an account whose token carries no role claim.
 *
 * ⛔ THE POINT OF THIS BLOCK IS THAT IT CLEARS THE CLAIM RATHER THAN ASSERTING ON
 * THE CODE PATH. `getSessionUser` used to read `app_metadata.role` and nothing
 * else; when the custom-access-token hook (0010) has not fired — it is enabled in
 * the Supabase dashboard, not by a migration, so a restored project simply does
 * not have it — the account signs in with `role: null` and every guard refuses
 * it while `profiles` says it is a manager. That is the standing lockout risk in
 * `LAUNCH_READINESS_HANDOFF.md`, and a test that only drove a working account
 * would go green whether or not it was fixed.
 *
 * The claim is cleared by construction, not by editing a token: the hook injects
 * the role only `if v_role is not null`, so signing in WHILE `profiles.role` is
 * null mints a token with no claim at all. Setting the role afterwards leaves
 * that already-issued token exactly as it was — which is the case the fix exists
 * to repair.
 *
 * ⚠️ Sign-in goes through the dev panel with a rewritten address, because
 * `devSignIn` is the only path a browser has to a password login and the panel
 * only draws buttons for the seeded seven. There is nothing to add to that list:
 * a fixture account with no role would have to be given one to be useful, and
 * then it would not be this test.
 */
test.describe("Path 6b — a session with no role claim", () => {
  const email = `no-claim-${Date.now()}@obhl.test`;
  let userId: string;
  let leagueId: string;

  test.beforeAll(async () => {
    const db = admin();
    const { data: created, error } = await db.auth.admin.createUser({
      // `devSignIn` signs in with the seeded local password and no other.
      email,
      password: "hockey123",
      email_confirm: true,
    });
    if (error) throw new Error(`createUser: ${error.message}`);
    userId = created!.user!.id;
    // NO ROLE. This is what makes the hook skip the claim.
    await db.from("profiles").upsert({
      id: userId,
      role: null,
      display_name: "No Claim Probe",
    });
    const { data: league } = await db
      .from("leagues")
      .select("id")
      .eq("slug", "obhl")
      .single();
    leagueId = league!.id;
    // Membership up front, so the ONLY thing that changes mid-test is
    // `profiles.role`. Without it the control would be refused by the membership
    // check instead and would prove nothing about the role one.
    await db
      .from("profile_leagues")
      .insert({ profile_id: userId, league_id: leagueId });
  });

  test.afterAll(async () => {
    const db = admin();
    await db.from("profile_leagues").delete().eq("profile_id", userId);
    await db.from("profiles").delete().eq("id", userId);
    await db.auth.admin.deleteUser(userId);
  });

  test("an account with no role claim but a role in profiles reaches the manage tools", async ({
    page,
  }) => {
    const db = admin();

    // Sign in while the role is still null — the token is minted without it.
    await page.goto("/login");
    // ⛔ LOCATE THE FORM, NEVER THE VALUE. `input[name="email"][value="…"]` is a
    // locator that deletes its own match: on a HIDDEN input `value` is a
    // reflected attribute, so `el.value = x` rewrites the very attribute the
    // selector keyed on and the following assertion finds no element at all.
    // Watched, in a browser: one match before the write, zero after. It is not a
    // hydration race and not a slow-runner flake — it can never pass anywhere.
    // Every other tamper in this suite locates its form by structure, which is
    // why none of them hit this.
    const manager = page.getByRole("button", { name: "Manager", exact: true });
    const devForm = page.locator("form").filter({ has: manager });
    await tamper(page, devForm.locator('input[name="email"]'), email);
    await manager.click();
    await page.waitForURL("/");

    // The probe is only worth anything if the claim really is absent.
    const claims = await accessTokenClaims(page);
    expect(claims.sub, "the session must be the probe account").toBe(userId);
    expect(
      claims.app_metadata?.role,
      "the token must carry NO role claim, or this test is measuring the happy path",
    ).toBeUndefined();

    // Control, same session: with no role anywhere, nothing is offered.
    await page.goto("/obhl/dashboard");
    await expect(page.getByText("Your account has no role yet")).toBeVisible();
    await page.goto("/obhl/people");
    await expect(page, "a role-guarded page must refuse it").toHaveURL("/");

    // The role lands in `profiles`. The token is NOT reissued.
    await db
      .from("profiles")
      .update({ role: "league_manager" })
      .eq("id", userId);

    // THE BAR: same token, same missing claim, and the tools are now reachable.
    await page.goto("/obhl/dashboard");
    await expect(page.getByRole("heading", { name: "Manage" })).toBeVisible();
    await expect(page.getByText("People & Roles").first()).toBeVisible();
    await page.goto("/obhl/people");
    await expect(
      page.getByRole("heading", { name: "People & Roles" }),
    ).toBeVisible();

    // …and it is still a claimless token that got there.
    expect((await accessTokenClaims(page)).app_metadata?.role).toBeUndefined();

    // The fallback grants the ROLE and nothing else: the League Office is a
    // tier, and `profiles.role` says nothing about it.
    await page.goto("/manage/office");
    await expect(page, "the office must still refuse").toHaveURL("/");
  });
});

/**
 * ⛔ `/login` DEFAULTS TO MAGIC LINK AND SHOWS NO PASSWORD FIELD, and must keep
 * doing so until the self-serve set-password flow exists.
 *
 * No existing staff account has a password — production's were made for
 * magic-link sign-in — so a password-primary login page shipped before anyone
 * can set one locks every real user out. This test is what makes that a build
 * failure rather than a discovery.
 */
test("login still defaults to the magic link, with no password field", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: "Send magic link" }),
  ).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

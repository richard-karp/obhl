/** Signing in and out: the dev panel, a claimless token, passwords and the reset mail. */
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

// Mailpit, from `[inbucket] port` in supabase/config.toml.
const MAIL = "http://127.0.0.1:54324/api/v1";

/**
 * ⚠️ `networkidle` BEFORE THE FIRST CLICK, and it is not padding. The password
 * form's submit is a server action: pre-hydration React posts the form for real,
 * so a click landing in that window behaves differently from one after it. The
 * earlier client-dispatcher version of this form silently ate the submit there —
 * see `login-form.tsx` — and this wait is what makes the test drive the state a
 * user reaches, rather than the race.
 */
async function signInWithPassword(
  page: Page,
  email: string,
  password: string,
) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  // ⚠️ BY ID, NOT BY ORDER. `/login` has two "Email" fields — the magic link's
  // and this one — and `getByLabel("Email").last()` would silently start driving
  // the magic-link form the day the blocks are reordered, failing every test
  // here with a message about none of that.
  await page.locator("#password-email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
}

/**
 * The newest message addressed to `email`, waited for.
 *
 * ⚠️ POLLED AND FILTERED BY RECIPIENT. Reading `messages[0]` straight after the
 * click assumes Mailpit has already ingested the mail and that nothing else
 * landed in the gap — an assumption that reddens a run for nothing the code did.
 * `/api/v1/search?query=to:<address>` is Mailpit's own filter; verified against
 * the running container rather than taken from documentation.
 */
async function newestMailIdFor(email: string): Promise<string> {
  const url = `${MAIL}/search?query=${encodeURIComponent(`to:${email}`)}`;
  let id: string | null = null;
  await expect
    .poll(
      async () => {
        const list = await (await fetch(url)).json();
        id = list.messages?.[0]?.ID ?? null;
        return id;
      },
      { message: `no mail for ${email} arrived` },
    )
    .not.toBeNull();
  return id!;
}

const signOut = (page: Page) => page.getByRole("button", { name: "Sign out" });

/**
 * ⛔ THE ORDER OF THE THREE ASSERTIONS BELOW IS LOAD-BEARING, and getting it
 * wrong makes a test that passes against the OLD behaviour. Every one of these
 * matchers retries, so any of them evaluated against the page the browser has
 * not left yet passes instantly:
 *
 *   - `toHaveURL("/")` after signing out FROM `/` is already true, always;
 *   - so is "the picker heading is visible", for the same reason.
 *
 * The sign-out button disappearing is the one condition that cannot be true
 * before the navigation, whatever the destination — so it goes first, and the
 * other two are only read once it holds. Watched: with the assertions in the
 * other order, the picker test passed against the `/login` redirect this change
 * replaces.
 */
async function assertLandedSignedOutOn(
  page: Page,
  url: string,
  heading: string,
) {
  await expect(signOut(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  await expect(page).toHaveURL(url);
}

const PICKER = ["/", "Choose your league"] as const;
const LEAGUE_HOME = ["/obhl", "Oceanview Beer Hockey League"] as const;

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
 * Path 24: the password half of auth — sign in, set your own, and the landing
 * that hands out the link.
 *
 * ⛔ NOTHING SEEDED IS TOUCHED. Every seeded account's password is `hockey123`
 * and `devSignIn` hardcodes it, so a test that changed one and then failed
 * before restoring it would break the quick sign-in every other spec uses. This
 * one makes its own auth user and deletes it, so the fixture cannot be dirtied
 * by a red step.
 *
 * ⚠️ WHAT THIS CANNOT PROVE: that a reset email arrives on PRODUCTION. The last
 * test here drives the whole loop against the local stack — request, read the
 * real message out of Mailpit, open the link, set a password — which covers
 * every hop except the one that needs the project's SMTP and a verified sending
 * domain. That hop is dashboard work and is not reachable from a test.
 */
test.describe("Path 24 — password sign-in", () => {
  const EMAIL = `password-path-${Date.now()}@obhl.test`;
  const PASSWORD = "hockey12345";
  let userId = "";

  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const db = admin();
    const { data, error } = await db.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(`createUser: ${error.message}`);
    userId = data!.user!.id;
  });

  /**
   * ⛔ AUDIT ROWS FIRST. `audit_log.user_id` references `auth.users` with no
   * cascade, so once this account has logged a password change, deleting it fails
   * — and `deleteUser`'s error is a returned value, not a throw, so the failure
   * would be silent and the account would outlive the test. Asserted, because a
   * cleanup that quietly does nothing is how a fixture rots.
   */
  test.afterAll(async () => {
    if (!userId) return;
    const db = admin();
    await db.from("audit_log").delete().eq("user_id", userId);
    const { error } = await db.auth.admin.deleteUser(userId);
    expect(error, "the test account must not outlive the test").toBeNull();
  });

  test("signs in with a password and lands on the league picker", async ({
    page,
  }) => {
    await signInWithPassword(page, EMAIL, PASSWORD);
    await expect(page).toHaveURL("/");
  });

  test("refuses a wrong password without saying which half was wrong", async ({
    page,
  }) => {
    await signInWithPassword(page, EMAIL, "wrongwrongwrong");
    await expect(page.getByRole("status")).toContainText("do not match");
    // No oracle: the same sentence for an address with no account at all.
    await signInWithPassword(page, `nobody-${Date.now()}@obhl.test`, PASSWORD);
    await expect(page.getByRole("status")).toContainText("do not match");
    await expect(page).toHaveURL(/\/login/);
  });

  test("sets its own password on the session, and the new one works", async ({
    page,
  }) => {
    await signInWithPassword(page, EMAIL, PASSWORD);
    await expect(page).toHaveURL("/");

    await page.goto("/set-password");
    await page.getByLabel("New password").fill("hockey54321");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("status")).toContainText("Password set");

    await page.context().clearCookies();
    await signInWithPassword(page, EMAIL, "hockey54321");
    await expect(page).toHaveURL("/");

    // ⛔ THE AUDIT ENTRY, ASSERTED RATHER THAN ASSUMED. `logAudit` swallows every
    // error by design, so a broken insert here is invisible in the app and would
    // never fail a test that only drove the UI.
    const { data: entries } = await admin()
      .from("audit_log")
      .select("action, entity_type, entity_id, new_data")
      .eq("entity_id", userId)
      .eq("action", "set_own_password");
    expect(
      entries?.length,
      "the password change must be logged",
    ).toBeGreaterThan(0);
    expect(entries![0].entity_type).toBe("office");
    // Never the password itself — the entries are read on the admin client.
    expect(JSON.stringify(entries![0].new_data)).not.toContain("hockey54321");
  });

  /**
   * The whole loop, through a real message.
   *
   * ⛔ THE HOP THIS EXISTS FOR is `redirectTo` surviving into the email and back
   * out of `/auth/confirm`. Measured on 2026-09-05: the mail carries
   * `redirect_to=…%2Fauth%2Fconfirm%3Fnext%3D%2Fset-password`, the browser lands
   * on `/auth/confirm?code=…&next=%2Fset-password`, and the route redirects to
   * `/set-password`. ⚠️ Note the PKCE `code` — there is NO `type` parameter, so
   * `/auth/confirm` cannot tell a recovery link from a magic link, which is why
   * the landing page has to be named in the query rather than inferred.
   *
   * ⛔ AND WHY THAT MATTERS OFF THIS MACHINE: a `redirectTo` that is not on
   * Supabase's allow-list is refused SILENTLY — measured, no error — and the mail
   * points at the Site URL instead, so the person lands signed-in on `/` with the
   * token spent. Locally this passes only because `config.toml` allows
   * `http://localhost:3000/**`. This test is green here and says nothing about
   * production's allow-list.
   *
   * Skips rather than fails when the local mail API is not answering: the port is
   * `[inbucket] port` from `supabase/config.toml`, and a red run on an assumption
   * about someone's environment is worse than a gap that announces itself.
   */

  test("the emailed link lands on /set-password and finishes the flow", async ({
    page,
  }) => {
    const reachable = await fetch(`${MAIL}/messages`).then(
      (r) => r.ok,
      () => false,
    );
    test.skip(
      !reachable,
      `no local mail API at ${MAIL} — skipping the mail loop`,
    );

    await page.context().clearCookies();
    await page.goto("/set-password");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect(page.getByRole("status")).toContainText("on its way");

    const id = await newestMailIdFor(EMAIL);
    const msg = await (await fetch(`${MAIL}/message/${id}`)).json();
    const body = (msg.Text ?? "") + (msg.HTML ?? "");
    const link = body
      .match(/https?:\/\/[^\s"'<>)]+verify[^\s"'<>)]*/)?.[0]
      ?.replace(/&amp;/g, "&");
    expect(link, "the reset mail must carry a verify link").toBeTruthy();
    expect(link, "…which must name the landing page").toContain(
      encodeURIComponent("/auth/confirm?next=/set-password"),
    );

    await page.goto(link!);
    await expect(page).toHaveURL(/\/set-password$/);
    await page.getByLabel("New password").fill("mailloop12345");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("status")).toContainText("Password set");

    // The password the loop just set is the one that works.
    await page.context().clearCookies();
    await signInWithPassword(page, EMAIL, "mailloop12345");
    await expect(page).toHaveURL("/");
  });
});

/**
 * Where signing out LANDS you.
 *
 * It used to be `/login` — the email-entry screen — which reads as a failed
 * sign-out rather than a finished one: the person deliberately left, and the app
 * answered by asking them to come back. The destination is now the public home
 * of the league they were in, and `/` when there is no league in context.
 *
 * ⛔ The slug arrives from the CLIENT, as a hidden field on the sign-out form,
 * and becomes a redirect target. The third test is the one that matters: a slug
 * that does not resolve must land on `/`, not on whatever was posted.
 */
test.describe("Sign-out destination", () => {
  test("from a league page it lands on that league's public home", async ({
    page,
  }) => {
    await signInAs(page, "Manager");
    await page.goto("/obhl/standings");
    await signOut(page).click();

    await assertLandedSignedOutOn(page, ...LEAGUE_HOME);
  });

  test("a posted slug that does not resolve lands on / rather than on itself", async ({
    page,
  }) => {
    await signInAs(page, "Manager");
    await page.goto("/obhl");
    // Rewriting the hidden field is exactly what an attacker controls. The
    // server has to resolve it rather than trust it.
    const field = page.locator('form input[name="league"]');
    await expect(field).toHaveValue("obhl");
    await field.evaluate((el) => {
      (el as HTMLInputElement).value = "no-such-league-anywhere";
    });
    await signOut(page).click();

    await assertLandedSignedOutOn(page, ...PICKER);
  });
});

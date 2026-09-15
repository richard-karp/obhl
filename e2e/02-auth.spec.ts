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

// A `.value` set before hydration is undone and the form posts its ORIGINAL value, so the tamper never
// happened and the test passes for the wrong reason. So settle, set, and assert.
async function tamper(page: Page, field: Locator, value: string) {
  await page.waitForLoadState("networkidle");
  await field.evaluate((el, v) => ((el as HTMLInputElement).value = v), value);
  await expect(field).toHaveValue(value);
}

// The access token the browser holds, reassembled from `@supabase/ssr`'s chunked base64url cookie for
// one assertion: a probe that assumes the role claim is missing proves nothing when it is present.
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

// ⚠️ `networkidle` before the first click, not padding: pre-hydration React posts the server-action
// form for real, so this drives the state a user reaches, not the race (`login-form.tsx`).
async function signInWithPassword(
  page: Page,
  email: string,
  password: string,
) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  // ⚠️ By id, not order: `/login` has two "Email" fields, and `.last()` would silently drive the
  // magic-link form if the blocks were reordered.
  await page.locator("#password-email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
}

// ⚠️ Polled and filtered by recipient (Mailpit's `search?query=to:`): reading `messages[0]` right after
// the click assumes the mail is in and nothing else landed.
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

// ⛔ The order is load-bearing: every matcher retries, and `toHaveURL("/")` or the picker heading pass
// on the page not yet left. The sign-out button disappearing cannot, so it goes first.
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

// ⛔ Clears the claim by construction: signing in while `profiles.role` is null mints a token with no
// role claim, the lockout in `RUNBOOK.md` → Deploy and operations → Setting up a hosted instance.
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
    // Membership up front, so only `profiles.role` changes mid-test; otherwise the control is refused
    // by the membership check and proves nothing about the role one.
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
    // ⛔ Locate the FORM, never the value: on a hidden input `value` is a reflected attribute, so
    // `el.value = x` rewrites what `input[value="…"]` keyed on and the match vanishes.
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

// ⛔ Nothing seeded is touched: `devSignIn` hardcodes `hockey123`, so this makes its own user.
// ⚠️ Green here says nothing about a reset email arriving on production (its SMTP and domain).
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

  // ⛔ Audit rows first: `audit_log.user_id` references `auth.users` with no cascade, and `deleteUser`
  // returns its error rather than throwing, so the delete is asserted.
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

    // ⛔ The audit entry, asserted: `logAudit` swallows every error by design, so a broken insert is
    // invisible in the app.
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

  // ⛔ Tests `redirectTo` surviving into the mail and out of `/auth/confirm` (a PKCE `code`, no `type`,
  // so `next` must name the page). ⚠️ Green locally says nothing about production's allow-list.

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

// Sign-out lands on the league's public home, or `/`. ⛔ The slug comes from a hidden form field and
// becomes a redirect target: one that does not resolve must land on `/`.
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

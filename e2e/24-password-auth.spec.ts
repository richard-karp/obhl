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
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// Mailpit, from `[inbucket] port` in supabase/config.toml.
const MAIL = "http://127.0.0.1:54324/api/v1";
const EMAIL = `password-path-${Date.now()}@obhl.test`;
const PASSWORD = "hockey12345";
let userId = "";

/**
 * ⚠️ `networkidle` BEFORE THE FIRST CLICK, and it is not padding. The password
 * form's submit is a server action: pre-hydration React posts the form for real,
 * so a click landing in that window behaves differently from one after it. The
 * earlier client-dispatcher version of this form silently ate the submit there —
 * see `login-form.tsx` — and this wait is what makes the test drive the state a
 * user reaches, rather than the race.
 */
async function signIn(page: Page, email: string, password: string) {
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
  await signIn(page, EMAIL, PASSWORD);
  await expect(page).toHaveURL("/");
});

test("refuses a wrong password without saying which half was wrong", async ({
  page,
}) => {
  await signIn(page, EMAIL, "wrongwrongwrong");
  await expect(page.getByRole("status")).toContainText("do not match");
  // No oracle: the same sentence for an address with no account at all.
  await signIn(page, `nobody-${Date.now()}@obhl.test`, PASSWORD);
  await expect(page.getByRole("status")).toContainText("do not match");
  await expect(page).toHaveURL(/\/login/);
});

test("sets its own password on the session, and the new one works", async ({
  page,
}) => {
  await signIn(page, EMAIL, PASSWORD);
  await expect(page).toHaveURL("/");

  await page.goto("/set-password");
  await page.getByLabel("New password").fill("hockey54321");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("status")).toContainText("Password set");

  await page.context().clearCookies();
  await signIn(page, EMAIL, "hockey54321");
  await expect(page).toHaveURL("/");

  // ⛔ THE AUDIT ENTRY, ASSERTED RATHER THAN ASSUMED. `logAudit` swallows every
  // error by design, so a broken insert here is invisible in the app and would
  // never fail a test that only drove the UI.
  const { data: entries } = await admin()
    .from("audit_log")
    .select("action, entity_type, entity_id, new_data")
    .eq("entity_id", userId)
    .eq("action", "set_own_password");
  expect(entries?.length, "the password change must be logged").toBeGreaterThan(
    0,
  );
  expect(entries![0].entity_type).toBe("office");
  // Never the password itself — the entries are read on the admin client.
  expect(JSON.stringify(entries![0].new_data)).not.toContain("hockey54321");
});

test("enforces the 8-character floor in the action, not just the browser", async ({
  page,
}) => {
  await signIn(page, EMAIL, "hockey54321");
  await expect(page).toHaveURL("/");
  await page.goto("/set-password");
  await page.waitForLoadState("networkidle");
  // Strip the courtesy constraint: the check that matters is the server's.
  await page.evaluate(() =>
    document.querySelector("#new-password")?.removeAttribute("minLength"),
  );
  await page.getByLabel("New password").fill("short");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("status")).toContainText("at least 8");
});

/**
 * ⚠️ LOOKS, DOES NOT SEND. The send lives in the mail-loop test below, and
 * Supabase rate-limits reset mail PER ADDRESS — a second request inside the
 * minute answers "For security purposes, you can only request this after N
 * seconds" instead of sending. Two tests mailing the same account is a red run
 * that says nothing about the app. (That sentence reaching the user is
 * deliberate; see the comment on the error path in `auth.ts:sendPasswordReset`.)
 */
test("a sessionless landing offers a fresh link instead of dead-ending", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto("/set-password");
  await page.waitForLoadState("networkidle");
  // No field that would write through a session this visitor does not have.
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Email me a link" }),
  ).toBeVisible();
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
  await signIn(page, EMAIL, "mailloop12345");
  await expect(page).toHaveURL("/");
});

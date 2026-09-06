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
 * ⚠️ WHAT THIS CANNOT PROVE: that a reset EMAIL arrives. `sendPasswordReset` is
 * exercised as far as Supabase accepting it; delivery needs the project's SMTP,
 * which is dashboard configuration and not reachable from a test.
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
  // Two "Email" fields on /login: the magic link's, then the password block's.
  await page.getByLabel("Email").last().fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
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

test.afterAll(async () => {
  if (userId) await admin().auth.admin.deleteUser(userId);
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

test("a sessionless landing offers a fresh link instead of dead-ending", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto("/set-password");
  await page.waitForLoadState("networkidle");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("status")).toContainText("on its way");
});

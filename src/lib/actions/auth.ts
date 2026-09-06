"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { devLoginEnabled } from "@/lib/auth/dev-login";
import { passwordProblem } from "@/lib/auth/password";

export type AuthActionState = { ok: boolean; message: string } | null;

/** Sends a magic-link email. Staff-only: unknown emails can't sign up. */
export async function sendMagicLink(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { ok: false, message: "Enter your email address." };

  const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${base}/auth/confirm`,
    },
  });

  if (error) return { ok: false, message: error.message };
  return {
    ok: true,
    message:
      "If that email belongs to a staff account, a sign-in link is on its way.",
  };
}

/**
 * Emails a password-reset link.
 *
 * ⛔ THE LINK MUST NAME ITS LANDING PAGE. `/auth/confirm` verifies the
 * `token_hash` for any `EmailOtpType` — `recovery` included — and then redirects
 * to whatever `next` says, defaulting to the league picker. Without
 * `?next=/set-password` the recovery session is established correctly and the
 * person is dropped on the picker with no way to finish, which looks exactly
 * like a broken link.
 *
 * ⚠️ Rides on custom SMTP. Supabase's built-in sender allows a couple of emails
 * an hour for the whole project, so this and `sendMagicLink` share that budget
 * until the dashboard's SMTP and rate limits are set.
 *
 * Reports the same thing whether or not the address has an account, like
 * `sendMagicLink`: /login is public, and a truthful answer here would make it an
 * address oracle for staff accounts.
 */
export async function sendPasswordReset(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { ok: false, message: "Enter your email address." };

  const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${base}/auth/confirm?next=/set-password`,
  });

  if (error) return { ok: false, message: error.message };
  return {
    ok: true,
    message:
      "If that email belongs to a staff account, a link to set a password is on its way.",
  };
}

/**
 * Sets the password of the account whose session is already established.
 *
 * ⛔ NOT `admin.updateUserById`. That one needs the admin client and sits behind
 * `requireCommissioner` (`office.ts`), and the whole point of this path is that
 * the person setting their own password is not a commissioner. `auth.updateUser`
 * writes through the CALLER's session, so the session is the authorisation and
 * there is nothing here to guard by role.
 *
 * The session it writes through is the recovery one `/auth/confirm` established
 * from the emailed `token_hash`, which is why this refuses rather than redirects
 * when there is none: arriving here without a link is the ordinary case (a
 * bookmark, an expired link), and it needs a sentence, not a bounce.
 *
 * ⚠️ The floor is checked HERE as well as by the browser's `minLength`, and
 * before Supabase gets a say — see `@/lib/auth/password` for why the number
 * cannot be left to Supabase.
 */
export async function updateOwnPassword(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const password = String(formData.get("password") ?? "");
  const tooShort = passwordProblem(password);
  if (tooShort) return { ok: false, message: tooShort };

  const supabase = await createClient();
  const { data, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || !data?.claims?.sub) {
    return {
      ok: false,
      message:
        "That link has expired or was already used — request a new one from the sign-in page.",
    };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { ok: false, message: error.message };
  return {
    ok: true,
    message: "Password set. You can sign in with it from now on.",
  };
}

/**
 * Signs in with an email and password.
 *
 * ⚠️ SECONDARY TO THE MAGIC LINK, deliberately. `/login` keeps offering the link
 * because most staff accounts have no password: this is the fallback for when
 * email is rate-limited or slow, not a replacement for it. Removing the link
 * would swap one sole way in for another sole way in.
 *
 * The refusal says nothing about which half was wrong — `/login` is public, and
 * "no account for that address" would make it an oracle for staff addresses, the
 * same reason `sendMagicLink` answers the way it does.
 *
 * The `audit_session` cookie is set here for the same reason `devSignIn` and
 * `/auth/confirm` set it: it groups a session's audit entries, and a sign-in path
 * that skipped it would file that session's writes under no session at all.
 */
export async function signInWithPassword(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password)
    return { ok: false, message: "Enter your email address and password." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error)
    return {
      ok: false,
      message:
        "That email and password do not match an account. Try the sign-in link instead.",
    };

  const cookieStore = await cookies();
  cookieStore.set("audit_session", crypto.randomUUID(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  // The picker, not a dashboard: /dashboard is league-scoped, and a sign-in
  // cannot know which league was meant. Same landing as `devSignIn`.
  redirect("/");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Quick sign-in for testing the staff tools, using the seeded password (set by
 * `npm run seed:users`). On in local dev; in a deployed build only when
 * ENABLE_DEV_LOGIN=true (see devLoginEnabled). Off = unavailable.
 */
export async function devSignIn(formData: FormData) {
  if (!devLoginEnabled()) return;
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return;
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password: "hockey123",
  });
  if (error) redirect(`/login?dev_error=${encodeURIComponent(error.message)}`);
  const cookieStore = await cookies();
  cookieStore.set("audit_session", crypto.randomUUID(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  // The picker, not a dashboard: /dashboard is league-scoped now.
  redirect("/");
}

"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { devLoginEnabled } from "@/lib/auth/dev-login";
import { passwordProblem } from "@/lib/auth/password";
import { logAudit } from "@/lib/audit";

export type AuthActionState = { ok: boolean; message: string } | null;

/**
 * ⛔ WHY THESE TWO ACTIONS NEVER REPORT THE PROVIDER'S ERROR.
 *
 * `/login` and `/set-password` are public and unauthenticated, so anything they
 * say differently for a real staff address than for a stranger's is an
 * enumeration oracle. GoTrue says plenty, **measured against the local stack on
 * 2026-09-06**:
 *
 * - `signInWithOtp` with `shouldCreateUser: false` → `422 otp_disabled`
 *   ("Signups not allowed for otp") for an address with no account, success for
 *   one with. **One request tells them apart.**
 * - `resetPasswordForEmail` → `200` either way on the first request, but the
 *   second within the throttle window returns `429 over_email_send_rate_limit`
 *   ONLY for an address that exists — the per-user `recovery_sent_at` throttle
 *   is never reached by an address with no user. **Two requests tell them
 *   apart.**
 *
 * ⚠️ An earlier version of this file passed `error.message` through and said in
 * a comment that the limit was per project and therefore safe. That was wrong,
 * and it was wrong in the direction that costs something. Both actions now
 * answer with the SAME sentence on every outcome, and the rate-limit advice is
 * part of that sentence unconditionally — a person who is being throttled reads
 * the same words as a person whose link is on its way, and gets told to wait
 * either way. The real error goes to the server log, where it helps whoever is
 * debugging and tells a stranger nothing.
 *
 * ⛔ Do not "improve" either message by reporting what actually happened.
 */

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

  if (error) console.error("sendMagicLink", error.message);
  // Identical whether the send succeeded, was throttled, or found no account.
  return {
    ok: true,
    message:
      "If that email belongs to a staff account, a sign-in link is on its way. " +
      "Links take a minute to arrive, and asking again straight away will not make one come sooner.",
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

  if (error) console.error("sendPasswordReset", error.message);
  // Identical whether the send succeeded, was throttled, or found no account —
  // see the comment above `sendMagicLink` for what the differences leak.
  return {
    ok: true,
    message:
      "If that email belongs to a staff account, a link to set a password is on its way. " +
      "Links take a minute to arrive, and asking again straight away will not make one come sooner.",
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
 * ANY session qualifies, not only a recovery one, and that is a CHOICE rather
 * than a limitation: the token's `amr` claim names the method that minted it, so
 * a recovery session could be told from an ordinary one right here. It is not,
 * because someone already signed in — by magic link, or by a password they want
 * to change — should be able to set one without mailing themselves a link
 * first. What matters is that a session exists, which is why this refuses rather
 * than redirects when there is none: arriving without one is the ordinary case
 * (a bookmark, an expired link), and it needs a sentence, not a bounce.
 *
 * ⚠️ The cost of that choice is that a stolen session can set a password and
 * outlive itself. `secure_password_change` is the dashboard control that would
 * demand reauthentication; it is unread on production, and step 1f of item 7 in
 * `LAUNCH_READINESS_HANDOFF.md` is where that is recorded.
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
  const claims = data?.claims as { sub?: string; email?: string } | undefined;
  if (claimsError || !claims?.sub) {
    return {
      ok: false,
      message:
        "That link has expired or was already used — request a new one from the sign-in page.",
    };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { ok: false, message: error.message };

  // ⛔ `entity_type: "office"` because that is the only type the log SHOWS for
  // an act with no league. A null league is hidden by RLS and filtered out of
  // every league-scoped view, so a bespoke type here would be written correctly
  // and be permanently invisible — the trap `audit.ts` warns about. Filed
  // beside the commissioner's `set_password`, which is the same event seen from
  // the other side; `office-audit-notice.tsx` gives it a sentence that does not
  // call it an office appointment.
  //
  // ⚠️ NO PASSWORD IN THE PAYLOAD, for the reason `setStaffPassword` gives at
  // length: these entries are read on the admin client, which is worse than a
  // league's log, not better. Actor and target are the same person — that IS
  // the distinction from `set_password`.
  // ⚠️ `display_name` IS THE POINT OF THE SNAPSHOT, not decoration. The office
  // reader takes the name from the entry first and the live `profiles` row only
  // as a fallback, because after a profile is deleted the snapshot is the only
  // thing left that says who this was. Omitting it here would make every one of
  // these entries fall back — and read as a truncated uuid the moment the
  // account is gone.
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", claims.sub)
    .maybeSingle();

  await logAudit({
    user_id: claims.sub,
    action: "set_own_password",
    entity_type: "office",
    entity_id: claims.sub,
    new_data: {
      profile_id: claims.sub,
      email: claims.email ?? null,
      display_name: profile?.display_name ?? null,
    },
  });

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

"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { devLoginEnabled } from "@/lib/auth/dev-login";
import { passwordProblem } from "@/lib/auth/password";
import { logAudit } from "@/lib/audit";
import { resolveLeagueBySlug } from "@/lib/league/current";
import { createAdminClient } from "@/utils/supabase/admin";

export type AuthActionState = { ok: boolean; message: string } | null;

/**
 * Where a successful sign-in lands, decided by the account's role.
 *
 * ⛔ TAKES THE ID THE SIGN-IN ALREADY RETURNED. `signInWithPassword` resolves to
 * `{ data: { user, session }, error }`, so the caller is holding the account id
 * the moment it succeeds. An earlier version threw that away and looked the
 * account back up by email through `findUserIdByEmail`, which PAGES THE AUTH
 * ADMIN API — up to fifty `listUsers` round trips — on every single sign-in, to
 * learn something it had already been told. It also had to lowercase the address
 * by hand, because that helper compares against a lowercased stored value and
 * treats a raw argument as a miss rather than an error; getting that wrong sent
 * anyone who capitalised their email to the picker, silently.
 *
 * ⛔ DO NOT REACH FOR `getSessionUser()` HERE EITHER. It is `cache()`-memoized
 * per request (`src/lib/auth/session.ts`), so the day anything reads the session
 * earlier in one of these actions it returns the pre-sign-in `null`, this
 * returns "/" forever, and nothing errors.
 *
 * ⚠️ A FAILED ROLE READ IS LOGGED, not swallowed. It still lands on the picker —
 * there is nowhere better to send someone mid-sign-in — but a scorekeeper
 * quietly arriving on the wrong page with no trace is the failure this whole
 * docblock exists to avoid.
 *
 * Anything that is not a scorekeeper gets the picker: `/dashboard` is
 * league-scoped and a sign-in cannot know which league was meant.
 */
async function landingForUser(userId: string): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("sign-in landing: role lookup failed:", error.message);
    return "/";
  }
  // The only surface a scorekeeper is meant to use. See the page's own docblock
  // for why it is `tonight` and not `score`.
  return data?.role === "scorekeeper" ? "/tonight" : "/";
}

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
  const { data: signedIn, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
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
  redirect(signedIn?.user ? await landingForUser(signedIn.user.id) : "/");
}

/**
 * Ends the session and lands the person on the public home of the league they
 * were in.
 *
 * It used to land on `/login`. Being handed the email-entry screen the instant
 * you deliberately signed out reads as a sign-out that failed, and the league's
 * own front page is where a person who has stopped being staff belongs — it is
 * the page they can still see.
 *
 * ⛔ THE SLUG COMES FROM THE CLIENT and becomes a redirect target, so it is
 * RESOLVED rather than trusted: `AccountCluster` posts it as a hidden field, and
 * anything at all can be typed into that field. `resolveLeagueBySlug` answers
 * null for a slug that names no league, and null lands on `/`. Interpolating the
 * posted value into the path directly would make this an open redirect within
 * the app's own URL space.
 *
 * ⚠️ It resolves AFTER `signOut()`, on a request whose session is already gone,
 * which is deliberate: the lookup reads through RLS, so a league that is not
 * public and not theirs any more does not resolve, and they land on `/` instead
 * of on a page that would 404 at them. A signed-out person's answer, for a
 * signed-out person's destination.
 *
 * `/` is also the answer when no slug is posted at all — the league picker
 * draws this cluster and has no league in its URL.
 */
export async function signOut(formData?: FormData) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const slug = String(formData?.get("league") ?? "").trim();
  const league = slug ? await resolveLeagueBySlug(slug) : null;
  redirect(league ? `/${league.slug}` : "/");
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
  const { data: signedIn, error } = await supabase.auth.signInWithPassword({
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
  redirect(signedIn?.user ? await landingForUser(signedIn.user.id) : "/");
}

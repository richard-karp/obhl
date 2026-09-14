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

// ⛔ Takes the id the sign-in returned: a lookup by email pages the auth admin API (up to fifty
// `listUsers` calls) on every sign-in, and silently misses a capitalised address.
async function landingForUser(userId: string): Promise<string> {
  // ⛔ Not `getSessionUser()`: it is `cache()`-memoized per request, so an earlier read in the
  // action returns the pre-sign-in `null` and everyone lands on "/".
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
  // Anyone else gets the picker: `/dashboard` is league-scoped and a sign-in knows no league.
  return data?.role === "scorekeeper" ? "/tonight" : "/";
}

// ⛔ Both sends answer one sentence on every outcome: /login is public, and GoTrue's errors
// (`422 otp_disabled`, a second request's `429`) tell a staff address from a stranger's.
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

// ⛔ The link must carry `?next=/set-password`: without it `/auth/confirm` lands the recovery
// session on the picker with no way to finish, which looks like a broken link.
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
  // Identical on every outcome, like `sendMagicLink`.
  return {
    ok: true,
    message:
      "If that email belongs to a staff account, a link to set a password is on its way. " +
      "Links take a minute to arrive, and asking again straight away will not make one come sooner.",
  };
}

// ⛔ `auth.updateUser`, not the admin API: the caller's session is the authorisation, so any
// session may set a password (`RUNBOOK.md` → Deploy and operations → Open ops items).
export async function updateOwnPassword(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const password = String(formData.get("password") ?? "");
  // ⚠️ The floor is checked here, before Supabase: see `@/lib/auth/password`.
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

  // ⚠️ `display_name` is snapshotted: once the profile is deleted it is the only name the
  // office log has.
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", claims.sub)
    .maybeSingle();

  // ⛔ `entity_type: "office"`, the only type the log shows with no league (`RUNBOOK.md` →
  // Access control → Traps). Never the password in the payload.
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

// The refusal never says which half was wrong: /login is public. The `audit_session` cookie
// groups the session's audit entries, as `devSignIn` and `/auth/confirm` set it.
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

// ⛔ The posted slug is resolved, never interpolated, or this is an open redirect. Resolved after
// `signOut()` on purpose: a league the signed-out viewer cannot see lands on "/", not a 404.
export async function signOut(formData?: FormData) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const slug = String(formData?.get("league") ?? "").trim();
  const league = slug ? await resolveLeagueBySlug(slug) : null;
  redirect(league ? `/${league.slug}` : "/");
}

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

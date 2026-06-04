"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";

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
    message: "If that email belongs to a staff account, a sign-in link is on its way.",
  };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * LOCAL-ONLY quick sign-in for testing the staff tools. Uses the seeded
 * password (set by `npm run seed:users`). Hard-disabled outside development so
 * it can never be used in production.
 */
export async function devSignIn(formData: FormData) {
  if (process.env.NODE_ENV === "production") return;
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return;
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password: "hockey123",
  });
  if (error) redirect(`/login?dev_error=${encodeURIComponent(error.message)}`);
  redirect("/dashboard");
}

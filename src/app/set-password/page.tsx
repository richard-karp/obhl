import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/utils/supabase/server";
import { RequestResetForm, SetPasswordForm } from "./set-password-form";

export const metadata: Metadata = { title: "Set your password" };

/**
 * Where a recovery link lands.
 *
 * `sendPasswordReset` asks for `?next=/set-password`, and `/auth/confirm`
 * verifies the `token_hash` and establishes the session before redirecting here
 * — so by the time this renders, the session IS the proof the email was
 * received. There is nothing else to check and no role to require: any staff
 * account may set its own password.
 *
 * ⚠️ Claims are read directly rather than through `getSessionUser`, which also
 * resolves a role from `profiles`. A session with no `profiles` row is exactly
 * the state that needs to be able to set a password, so a null role must not
 * read as "not signed in" here.
 *
 * Arriving with no session is the ordinary case — a bookmark, a link used
 * twice, an expired one — so it answers with the form that sends a fresh link
 * rather than a redirect or a dead end. One URL covers both halves of the flow:
 * ask for the link, and finish with it.
 */
export default async function SetPasswordPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims as { sub?: string; email?: string } | undefined;
  const signedIn = !error && Boolean(claims?.sub);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-bold tracking-tight">
            Set your password
          </h1>
          <p className="text-muted-foreground text-sm">
            {signedIn
              ? claims?.email
                ? `For ${claims.email}. You can still use a sign-in link any time.`
                : "You can still use a sign-in link any time."
              : "We'll email you a link. Open it and you can choose a password."}
          </p>
        </div>

        {signedIn ? <SetPasswordForm /> : <RequestResetForm />}

        <p className="text-muted-foreground text-center text-xs">
          <Link href="/login" className="hover:underline">
            ← Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

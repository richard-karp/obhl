import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/utils/supabase/server";
import { RequestResetForm, SetPasswordForm } from "./set-password-form";

export const metadata: Metadata = { title: "Set your password" };

// ⚠️ Claims, not `getSessionUser`: a session with no `profiles` row must still set a password, so a
// null role must not read as signed out. The session from `/auth/confirm` is the proof; no role needed.
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

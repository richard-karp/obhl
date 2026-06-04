import Link from "next/link";
import type { Metadata } from "next";
import { LoginForm } from "./login-form";
import { devSignIn } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Staff sign in" };

const DEV_ACCOUNTS = [
  { label: "Manager", email: "manager@obhl.test" },
  { label: "Scorekeeper", email: "scorekeeper@obhl.test" },
  { label: "Captain", email: "captain@obhl.test" },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ dev_error?: string }>;
}) {
  const { dev_error } = await searchParams;
  const isDev = process.env.NODE_ENV !== "production";

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Staff sign in</h1>
          <p className="text-muted-foreground text-sm">
            For league managers, captains, and scorekeepers.
          </p>
        </div>
        <LoginForm />

        {isDev ? (
          <div className="space-y-2 rounded-lg border border-dashed p-3">
            <p className="text-muted-foreground text-center text-xs font-medium">
              Dev quick sign-in (local only)
            </p>
            <div className="flex gap-2">
              {DEV_ACCOUNTS.map((a) => (
                <form key={a.email} action={devSignIn} className="flex-1">
                  <input type="hidden" name="email" value={a.email} />
                  <Button
                    type="submit"
                    variant="secondary"
                    size="sm"
                    className="w-full"
                  >
                    {a.label}
                  </Button>
                </form>
              ))}
            </div>
            {dev_error ? (
              <p className="text-destructive text-center text-xs">{dev_error}</p>
            ) : null}
          </div>
        ) : null}

        <p className="text-muted-foreground text-center text-xs">
          <Link href="/" className="hover:underline">
            ← Back to the league site
          </Link>
        </p>
      </div>
    </div>
  );
}

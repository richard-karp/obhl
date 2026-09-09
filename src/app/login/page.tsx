import Link from "next/link";
import type { Metadata } from "next";
import { LoginForm, PasswordSignInForm } from "./login-form";
import { devSignIn } from "@/lib/actions/auth";
import { devLoginEnabled } from "@/lib/auth/dev-login";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Staff sign in" };

// Manager/Scorekeeper/Captain belong to every seeded league. The two One-league
// accounts are confined to one, and that is the point of them — without an
// account that cannot reach every league, a guard that checks membership and a
// guard that checks nothing behave identically. Commissioner and Deputy hold an
// office tier instead, which reaches every league WITHOUT a membership row, and
// No-league mgr holds neither, so it is the only one every league-scoped guard
// turns away. WHICH league each is confined to is the seed script's business,
// not this file's: nothing here should know what leagues exist.
//
// ⚠️ Counting phrases go stale here — this said "the first three… the last two"
// while there were seven accounts. Name the roles, not the positions.
const DEV_ACCOUNTS = [
  { label: "Manager", email: "manager@obhl.test" },
  { label: "Scorekeeper", email: "scorekeeper@obhl.test" },
  { label: "Captain", email: "captain@obhl.test" },
  { label: "One-league mgr", email: "single-league-lead@obhl.test" },
  { label: "One-league scorer", email: "single-league-scorer@obhl.test" },
  // Commissioner and Deputy: the League Office. Neither belongs to any league —
  // the tier reaches every league without a membership row — so they are the
  // only way to drive implicit membership from a browser.
  { label: "Commissioner", email: "commissioner@obhl.test" },
  { label: "Deputy", email: "deputy@obhl.test" },
  // No-league mgr: the role and no league at all — no membership row and no
  // office tier, so every league-scoped guard turns them away. The account that
  // can only create a league, which is what it is here to drive.
  { label: "No-league mgr", email: "no-league-mgr@obhl.test" },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ dev_error?: string; error?: string }>;
}) {
  const { dev_error, error } = await searchParams;
  const showDevLogin = devLoginEnabled();

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Staff sign in</h1>
          <p className="text-muted-foreground text-sm">
            For league managers, captains, and scorekeepers.
          </p>
        </div>
        {error === "link" ? (
          <p
            role="alert"
            className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-center text-sm"
          >
            That sign-in link is invalid or expired — request a new one below.
          </p>
        ) : null}
        <LoginForm />

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="bg-border h-px flex-1" />
            <span className="text-muted-foreground text-xs">
              or use a password
            </span>
            <span className="bg-border h-px flex-1" />
          </div>
          <PasswordSignInForm />
        </div>

        {showDevLogin ? (
          <div className="space-y-2 rounded-lg border border-dashed p-3">
            <p className="text-muted-foreground text-center text-xs font-medium">
              Quick sign-in (test mode)
            </p>
            {/*
              `flex-wrap`: eight accounts of `flex-1` buttons no longer fit one
              row inside this card, and without it the row overflows its border
              rather than wrapping. Dev-only, and no spec measures this page's
              width — but horizontal overflow is treated as a real defect
              elsewhere in this repo, so it is not left for the ninth account to
              make worse.
            */}
            <div className="flex flex-wrap gap-2">
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
              <p className="text-destructive text-center text-xs">
                {dev_error}
              </p>
            ) : null}
          </div>
        ) : null}

        <p className="text-muted-foreground text-center text-xs">
          <Link href="/" className="hover:underline">
            ← Back to all leagues
          </Link>
        </p>
      </div>
    </div>
  );
}

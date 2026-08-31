import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { getPublicLeagues } from "@/lib/league/current";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { ThemeToggle } from "@/components/shared/theme-toggle";

/**
 * Root landing page: the one place that isn't league-scoped. Every league lives
 * at `/<slug>` from here on, so this is what a bare domain, a role-denied
 * redirect, and a completed sign-in all land on.
 */
export default async function LandingPage() {
  const supabase = await createClient();
  const leagues = await getPublicLeagues(supabase);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-10">
      <div className="mb-10 flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Choose your league
          </h1>
          <p className="text-muted-foreground">
            Standings, schedules, stats, teams, and rules.
          </p>
        </div>
        <ThemeToggle />
      </div>

      {leagues.length === 0 ? (
        // A freshly bootstrapped database renders this: the site is up before
        // any league exists.
        <EmptyState
          title="No leagues yet"
          description="Once a league is published it will appear here."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {leagues.map((l) => (
            <Link key={l.slug} href={`/${l.slug}`}>
              <Card className="hover:border-primary h-full transition-colors">
                <CardContent className="space-y-1 p-5">
                  <span className="block font-semibold">{l.name}</span>
                  <span className="text-muted-foreground block text-sm">
                    /{l.slug}
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <footer className="text-muted-foreground mt-auto pt-10 text-sm">
        <Link href="/login" className="hover:text-foreground transition-colors">
          Staff sign in
        </Link>
      </footer>
    </div>
  );
}

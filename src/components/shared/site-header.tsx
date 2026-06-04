import Link from "next/link";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";
import { LeagueSwitcher } from "./league-switcher";
import { createClient } from "@/utils/supabase/server";
import { getPublicLeagues, resolveCurrentLeague } from "@/lib/league/current";

export async function SiteHeader() {
  const supabase = await createClient();
  const [leagues, current] = await Promise.all([
    getPublicLeagues(supabase),
    resolveCurrentLeague(supabase),
  ]);

  return (
    <header className="bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
          <span className="bg-primary text-primary-foreground inline-flex size-7 items-center justify-center rounded-md text-xs">
            OB
          </span>
          <span className="hidden sm:inline">OBHL</span>
        </Link>
        <div className="hidden md:block">
          <NavLinks />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <LeagueSwitcher leagues={leagues} currentSlug={current?.slug ?? ""} />
          <ThemeToggle />
        </div>
      </div>
      <div className="border-t px-2 py-1 md:hidden">
        <NavLinks />
      </div>
    </header>
  );
}

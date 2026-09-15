import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";
import { EndOfDaySignOut } from "./end-of-day-signout";
import { leagueToday } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AppRole } from "@/lib/auth/session";

const ROLE_LABEL: Record<AppRole, string> = {
  league_manager: "Manager",
  scorekeeper: "Scorekeeper",
  captain: "Captain",
};

// ⛔ Not `AccountCluster`: the account is shared, so no Password link and no Sign out. ⚠️ The session then ends
// only on the day boundary (`EndOfDaySignOut`); if that stops, a rink laptop stays signed in.
export function ScorekeeperChrome({
  role,
  /** Draw the button back to tonight's games; false on `/tonight` itself. */
  showTonight = false,
}: {
  role: AppRole | null;
  showTonight?: boolean;
}) {
  return (
    <div className="mb-6 flex items-center gap-3">
      {/*
        ⛔ Mounted here, not on `/tonight` alone: a night ends on a scoresheet, and nothing else ends the session.
      */}
      {role === "scorekeeper" ? (
        <EndOfDaySignOut renderedFor={leagueToday()} />
      ) : null}
      {showTonight ? (
        // ⚠️ A filled Button: a scorekeeper's only navigation, which as a quiet link read as decoration.
        <Button asChild size="sm">
          <Link href="/tonight">← Tonight</Link>
        </Button>
      ) : null}
      {/*
        ⚠️ `canScoreLeague` admits managers to `/tonight` too, and they need a way out.
      */}
      {role !== "scorekeeper" ? (
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground text-sm whitespace-nowrap transition-colors"
        >
          ← All leagues
        </Link>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        {role ? (
          <Badge variant="secondary" className="hidden sm:inline-flex">
            {ROLE_LABEL[role]}
          </Badge>
        ) : null}
        <ThemeToggle />
      </div>
    </div>
  );
}

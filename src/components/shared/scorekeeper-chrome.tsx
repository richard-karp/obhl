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

/**
 * The only chrome a scorekeeper ever sees: who they are, the theme switch, and
 * the way back to tonight.
 *
 * ⛔ DELIBERATELY NOT `AccountCluster`. That component always renders a Password
 * link and a Sign out button for a signed-in viewer, and neither belongs here —
 * the account is SHARED, so "Password" invites a volunteer to change a
 * credential every other scorekeeper depends on, and signing out is handled for
 * them when their day rolls over rather than being a button to forget.
 *
 * ⚠️ It follows that there is no manual way out. That is the trade: the session
 * ends on the day boundary instead (see `endOfDaySignOut`), which is the half
 * that has to keep working. If it stops, a shared account stays signed in on a
 * rink laptop indefinitely.
 */
export function ScorekeeperChrome({
  role,
  /**
   * Draw the button back to tonight's games. False on `/tonight` itself, where
   * it would point at the page you are already on.
   */
  showTonight = false,
}: {
  role: AppRole | null;
  showTonight?: boolean;
}) {
  return (
    <div className="mb-6 flex items-center gap-3">
      {/*
        ⛔ MOUNTED HERE, NOT ON `/tonight` ALONE. A scorekeeper's night does not
        end on the list — it ends on a SCORESHEET: complete the last game, put
        the laptop down, walk away. Mounting the timer only on `/tonight` missed
        exactly the case it exists for, and this chrome removed the Sign out
        button, so nothing else would have ended that session. It renders
        nothing; putting it beside the chrome guarantees it is wherever a
        scorekeeper is.
      */}
      {role === "scorekeeper" ? (
        <EndOfDaySignOut renderedFor={leagueToday()} />
      ) : null}
      {showTonight ? (
        // ⚠️ A filled Button, not a muted text link. This is the ONLY navigation
        // a scorekeeper has — the way out of a scoresheet and back to the night
        // — and as a quiet link beside the account chrome it read as decoration.
        <Button asChild size="sm">
          <Link href="/tonight">← Tonight</Link>
        </Button>
      ) : null}
      {/*
        ⚠️ NOT A DEAD END FOR EVERYONE ELSE. `canScoreLeague` admits MANAGERS to
        `/tonight` too, and stripping the account chrome left them with a badge, a
        theme toggle and no way out. A scorekeeper is meant to have nowhere else
        to go; a manager is not.
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

import { Badge } from "@/components/ui/badge";
import { NIGHT_LABEL, NIGHT_LONG } from "@/lib/season/nights";

/**
 * The night a player turns out, as a one-letter pill beside their name.
 *
 * ⛔ THIS REPLACED A `Night` COLUMN ON BOTH ROSTER TABLES, and the reason is
 * density: the column was one cell wide on every row of every section, and on
 * a real roster almost all of those cells are `—`. Only players with a fixed
 * night carry anything, so only they get a pill — the same shape the captain
 * `C` and rookie `R` already have, and read the same way.
 *
 * ⚠️ FIRST LETTER ONLY, WHICH MEANS TUESDAY AND THURSDAY ARE BOTH `T`. The
 * maintainer's own league plays exactly those two nights and chose the single
 * letter anyway, over `Tu`/`Th` and over the three-letter `NIGHT_LABEL`. The
 * `title` is what resolves the pair on hover; do not "fix" the collision by
 * widening the letter without asking.
 *
 * ⚠️ `title` AND NOTHING ELSE — no `aria-label`, no `sr-only`. The badge is a
 * `<span>` with no role, so ARIA prohibits naming it and an `aria-label` would
 * be dropped. `sr-only` text WOULD be announced, but it also lands in
 * `innerText`, and the roster e2e strips badge text out of name cells by
 * string-replacing it (`04-rosters`, `10-roster-changes`) — `season-select.tsx`
 * records the last time an `sr-only` string collided with that suite. The four
 * badges beside this one (`C`, `R`, `SUSP`, `INJ`) carry no accessible name
 * either; giving one of five a name is the inconsistency, not the fix.
 *
 * ⚠️ A NIGHT OUTSIDE THE SEASON'S IS RENDERED, NOT HIDDEN — but the caller
 * decides whether the pill appears at all. A season regenerated onto fewer
 * nights leaves assignments pointing at a night it no longer plays; the stored
 * value is shown rather than silently discarding a manager's work. It is always
 * a real weekday: `team_players.night_of_week` is `check (between 0 and 6)`
 * since `0049`, so `NIGHT_LABEL[night]` cannot come back undefined.
 */
export function NightBadge({ night }: { night: number | null }) {
  if (night === null) return null;
  return (
    <Badge
      variant="outline"
      className="ml-1 px-1.5 py-0 text-[0.65rem]"
      title={NIGHT_LONG[night]}
    >
      {NIGHT_LABEL[night][0]}
    </Badge>
  );
}

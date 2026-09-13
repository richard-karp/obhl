import Link from "next/link";
import { TeamLogo } from "@/components/shared/team-logo";

/**
 * A team's crest, beside a player's name, linking to the team.
 *
 * Both stats tables dropped their wide `Team` column — the crest carries the
 * team now, at every width, where the column was `hidden sm:table-cell` and so
 * told a phone nothing. This is the shared piece because it is the third thing
 * that has to be got right at once and the two tables would drift:
 *
 * ⛔ THE LINK NEEDS `aria-label`, BECAUSE THE CHIP HAS NO NAME OF ITS OWN.
 * `TeamLogo` is `aria-hidden` in its monogram branch and `alt=""` in its image
 * branch — deliberately, since a dozen callers draw it next to the team name it
 * would otherwise repeat. Wrapping it in a bare anchor makes a link with no
 * accessible name at all, which is worse than the column it replaced. ⚠️ Do NOT
 * "fix" that by naming `TeamLogo` itself: `season-select.tsx:19` records an
 * `sr-only` string colliding with `04-rosters`' selectors once already, and the
 * name belongs to this link rather than to the chip.
 *
 * ⚠️ `hover:underline` stays OFF this anchor and on the player's name instead.
 * A text decoration on an ancestor is propagated to in-flow descendants and a
 * descendant cannot switch it back off — `team-logo.tsx`'s docblock measures
 * every attempt. The chip's letters dodge it by being out of flow; putting an
 * underline on a parent both share would paint a line across them again.
 *
 * ⚠️ A player with no CURRENT team has no slug. `v_skater_season_totals` and
 * `v_goalie_season_totals` LEFT JOIN the active roster row (`0044`), so someone
 * who has left the league keeps their season line and loses their team columns.
 * They get the chip without a link — the previous markup linked to
 * `/<league>/teams/null`.
 */
export function TeamCrestLink({
  slug,
  name,
  color,
  logoPath,
  textColor,
  league,
}: {
  slug: string | null;
  name: string | null;
  color: string | null;
  logoPath: string | null;
  textColor: string | null;
  league: string;
}) {
  const crest = (
    <TeamLogo
      name={name ?? ""}
      color={color}
      logoPath={logoPath}
      textColor={textColor}
    />
  );
  if (!slug) return crest;
  return (
    <Link href={`/${league}/teams/${slug}`} aria-label={name ?? "Team"}>
      {crest}
    </Link>
  );
}

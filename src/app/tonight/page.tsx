import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser, canScoreLeague } from "@/lib/auth/guards";
import { getMemberLeagues } from "@/lib/auth/membership";
import { getGamesOnDate } from "@/lib/queries/schedule";
import { formatLongDate, leagueToday } from "@/lib/format";
import { GameRow } from "@/components/public/game-row";
import { PageHeader } from "@/components/shared/page-header";
import { ScorekeeperChrome } from "@/components/shared/scorekeeper-chrome";
import { EmptyState } from "@/components/shared/empty-state";

// Declared here because there is no `src/app/manage/layout.tsx` to supply one —
// the same reason `office/page.tsx` and `leagues/new/page.tsx` each declare
// their own. The root template renders this as "Tonight · OBHL".
export const metadata: Metadata = { title: "Tonight" };

/**
 * The scorekeeper's night: every game happening TODAY, across every league they
 * keep score for, and nothing else.
 *
 * ⚠️ `/manage/score` EXISTED BEFORE AND WAS DELIBERATELY DELETED (`fbb0802`),
 * absorbed into the public schedule because it was "the same games in a table
 * with a button on each row" — see the note at `[league]/(public)/schedule/page.tsx`.
 * This is NOT that page coming back. The old one was per-league, whole-season
 * and a convenience; this is cross-league, one-day, and a RESTRICTION — it is
 * the only surface a scorekeeper is meant to use. Keying on the date rather than
 * the season also sidesteps the problem that note describes: a game in an
 * inactive imported season still shows up, because nothing here asks which
 * season is active.
 *
 * ⛔ `tonight` IS A RESERVED LEAGUE SLUG (`0048_reserve_tonight_slug.sql`,
 * mirrored in `src/lib/league/reserved-slugs.ts`), and that reservation is the
 * ONLY thing making a top-level route safe here. Without it a league named
 * "Tonight" is created at an address that can never resolve — Next matches the
 * static segment first — and there is no UI to delete one. `reserved-slugs.test.ts`
 * fails if the SQL list and the app list ever disagree.
 *
 * ⚠️ IT LIVED AT `/manage/tonight` FIRST, and could never be called
 * `/manage/score`: `next.config.ts` redirects `/:league/score ->
 * /:league/schedule`, `:league` matches ANY first segment including `manage`,
 * and redirects run before the filesystem. Watched happening. That hazard still
 * applies to anything new under `/manage/` — check its second segment against
 * that redirect list first.
 *
 * There is no layout out here, so this page gets NO site header and NO staff
 * links row. For a page whose whole purpose is to be the only thing its viewer
 * sees, that is the feature rather than a gap — but it does mean this file has
 * to draw its own frame and its own way out.
 */
export default async function ScoreTonightPage() {
  const user = await requireUser();

  // ⛔ `canScoreLeague`, NOT membership, AND THE REASON IS CAPTAINS.
  //
  // The scoresheet admits them — `requireLeagueRole(league.id, "captain",
  // "scorekeeper", "league_manager")` — so a captain who reached this page on
  // membership alone would be handed a button into every game tonight,
  // including games their own team is not in. `canScoreLeague` excludes
  // captains deliberately, and says why: drawing a Score button beside every
  // game "would suggest a scope they do not have". Asking the same question the
  // schedule page asks is what stops this page becoming the loophole.
  //
  // Both `getSessionUser` and `memberLeagueIds` beneath it are memoized per
  // request, so this is one round of cheap questions, not one per league.
  const leagues = await getMemberLeagues(user.id);
  const scorable = (
    await Promise.all(
      leagues.map(async (l) => ((await canScoreLeague(l.id)) ? l : null)),
    )
  ).filter((l) => l !== null);
  if (scorable.length === 0) redirect("/");

  const today = leagueToday();
  const { games, readFailed } = await getGamesOnDate(
    scorable.map((l) => l.id),
    today,
  );

  // Every row can belong to a different league, and `GameRow` needs a slug for
  // its box-score link. `getGamesOnDate` returns `league_id` for exactly this.
  const slugById = new Map(scorable.map((l) => [l.id, l.slug]));
  const nameById = new Map(scorable.map((l) => [l.id, l.name]));

  // Grouped so three games in one league carry one heading rather than three.
  // In practice there is always one group — the two leagues play different
  // nights — but nothing here depends on that staying true.
  const byLeague = games.reduce<Map<string, typeof games>>((acc, game) => {
    const group = acc.get(game.league_id) ?? [];
    group.push(game);
    acc.set(game.league_id, group);
    return acc;
  }, new Map());

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
      {/*
        ⛔ NO "All leagues", NO "Password", NO "Sign out". A scorekeeper gets
        their role, the theme switch, and nothing else. The account is SHARED, so
        a Password link invites a volunteer to change a credential every other
        scorekeeper depends on; signing out happens on the day boundary rather
        than being a button someone forgets to press.
      */}
      <ScorekeeperChrome role={user.role} />

      <PageHeader title="Tonight" description={formatLongDate(today)} />

      {readFailed ? (
        /*
          ⛔ NOT THE EMPTY STATE. "There are no games tonight" and "the read
          failed" are different sentences, and this is the only page a
          scorekeeper has — telling them the rink is quiet when the query errored
          sends them home mid-shift. Same rule `getScheduleConstraints` states in
          its own docblock.
        */
        <EmptyState
          title="Couldn't load tonight's games"
          description="Something went wrong reading the schedule — this is not the same as there being no games. Reload, and tell a manager if it keeps happening."
        />
      ) : games.length === 0 ? (
        <EmptyState
          title="No games today"
          description="When tonight's games are scheduled they'll appear here, ready to score."
        />
      ) : (
        <div className="space-y-8">
          {[...byLeague.entries()].map(([leagueId, group]) => (
            <section key={leagueId} className="space-y-3">
              <h2 className="text-muted-foreground text-sm font-medium">
                {nameById.get(leagueId)}
              </h2>
              {group.map((game) => (
                <GameRow
                  key={game.id}
                  game={game}
                  league={slugById.get(game.league_id) ?? ""}
                  // ⛔ NO BUTTON FOR A CANCELLED GAME. A cancelled game KEEPS
                  // its date (a postponed one has `scheduled_at` nulled by
                  // `0025`, so it can never land here at all), which means one
                  // cancelled today appears in this list. `scoreLabel` would
                  // draw it a "Manage" button, and `0046`'s trigger refuses a
                  // non-manager moving `status` out of `cancelled` — so the
                  // button could only ever be a dead end. The row still shows,
                  // because a scorekeeper at the rink needs to know the game is
                  // off.
                  scoreHref={
                    game.status === "cancelled"
                      ? undefined
                      : `/${slugById.get(game.league_id) ?? ""}/games/${game.id}/score`
                  }
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

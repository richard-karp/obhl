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

export const metadata: Metadata = { title: "Tonight" };

// ⛔ `tonight` is a reserved league slug (`0048`, mirrored in `reserved-slugs.ts`): without it a league
// named "Tonight" gets an address that never resolves, and there is no UI to delete one.
export default async function ScoreTonightPage() {
  const user = await requireUser();

  // ⛔ `canScoreLeague`, not membership: the scoresheet admits captains, so membership alone would
  // hand a captain a Score button into every game tonight, their team's or not.
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

  const slugById = new Map(scorable.map((l) => [l.id, l.slug]));
  const nameById = new Map(scorable.map((l) => [l.id, l.name]));

  const byLeague = games.reduce<Map<string, typeof games>>((acc, game) => {
    const group = acc.get(game.league_id) ?? [];
    group.push(game);
    acc.set(game.league_id, group);
    return acc;
  }, new Map());

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
      {/*
        ⛔ No "All leagues", "Password" or "Sign out": the account is shared, so a Password link invites
        changing everyone's credential, and sign-out happens on the day boundary.
      */}
      <ScorekeeperChrome role={user.role} />

      <PageHeader title="Tonight" description={formatLongDate(today)} />

      {readFailed ? (
        // ⛔ Not the empty state: this is a scorekeeper's only page, and "no games tonight" when the
        // read failed sends them home mid-shift.
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
                  // ⛔ No button for a cancelled game: it keeps its date and shows here, but `0046`
                  // refuses a non-manager moving `status` out of `cancelled`, so it is a dead end.
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

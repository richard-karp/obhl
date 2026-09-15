import { notFound } from "next/navigation";
import { getActiveContext } from "@/lib/queries/season";
import { getGameBoxScore } from "@/lib/queries/games";
import { BoxScore } from "@/components/public/box-score";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { formatGameDateTime } from "@/lib/format";

export default async function GamePage({
  params,
}: {
  params: Promise<{ league: string; gameId: string }>;
}) {
  const { league, gameId } = await params;
  const [ctx, box] = await Promise.all([
    getActiveContext(league),
    getGameBoxScore(gameId),
  ]);
  if (!box) notFound();

  // An id names no league: without this, /harbor/games/<an-obhl-id> renders under Harbor's header. The
  // league, not its active season, so links to a finished season's games keep resolving.
  if (box.game.season.league_id !== ctx.league.id) notFound();

  const { game } = box;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${game.away_team?.name ?? "TBD"} @ ${game.home_team?.name ?? "TBD"}`}
        description={formatGameDateTime(game.scheduled_at)}
      />
      {game.status === "final" ? (
        <BoxScore box={box} />
      ) : (
        <EmptyState
          title="Box score not available yet"
          description="The box score will appear here once the game is final."
        />
      )}
    </div>
  );
}

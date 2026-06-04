import { notFound } from "next/navigation";
import { getGameBoxScore } from "@/lib/queries/games";
import { BoxScore } from "@/components/public/box-score";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { formatGameDateTime } from "@/lib/format";

export default async function GamePage({
  params,
}: {
  params: Promise<{ gameId: string }>;
}) {
  const { gameId } = await params;
  const box = await getGameBoxScore(gameId);
  if (!box) notFound();
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

import { setLineup, bumpStat, finalizeGame, reopenGame } from "@/lib/actions/games";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GameStatusBadge } from "@/components/shared/game-status-badge";
import { TeamLogo } from "@/components/shared/team-logo";

export type DressedLine = {
  rosterId: string;
  number: number | null;
  goals: number;
  assists: number;
  pim: number;
};
export type RosterCheck = {
  playerId: string;
  number: number | null;
  dressed: boolean;
};
export type TeamBoard = {
  id: string;
  name: string;
  color: string | null;
  dressed: DressedLine[];
  roster: RosterCheck[];
};
export type ScoreBoardData = {
  gameId: string;
  status: string;
  finalized: boolean;
  awayName: string;
  homeName: string;
  awayId: string;
  homeId: string;
  awayScore: number;
  homeScore: number;
  boards: TeamBoard[];
  canScore: boolean;
  canManage: boolean;
  captainTeamId: string | null;
};

const STAT_COLS = [
  { col: "goals", label: "G" },
  { col: "assists", label: "A" },
  { col: "pim", label: "PIM" },
] as const;

function Stepper({
  gameId,
  rosterId,
  col,
  sign,
}: {
  gameId: string;
  rosterId: string;
  col: string;
  sign: "+" | "−";
}) {
  return (
    <form action={bumpStat}>
      <input type="hidden" name="game_id" value={gameId} />
      <input type="hidden" name="id" value={rosterId} />
      <input type="hidden" name="col" value={col} />
      <input type="hidden" name="delta" value={sign === "+" ? "1" : "-1"} />
      <Button
        type="submit"
        variant="outline"
        size="icon"
        className="size-7 text-base leading-none"
        aria-label={`${sign === "+" ? "Add" : "Remove"} ${col}`}
      >
        {sign}
      </Button>
    </form>
  );
}

function StatCell({
  gameId,
  rosterId,
  col,
  value,
  editable,
}: {
  gameId: string;
  rosterId: string;
  col: string;
  value: number;
  editable: boolean;
}) {
  return (
    <div className="flex w-24 items-center justify-center gap-1.5">
      {editable ? (
        <Stepper gameId={gameId} rosterId={rosterId} col={col} sign="−" />
      ) : null}
      <span className="w-5 text-center text-sm font-semibold tabular-nums">
        {value}
      </span>
      {editable ? (
        <Stepper gameId={gameId} rosterId={rosterId} col={col} sign="+" />
      ) : null}
    </div>
  );
}

function LineupEditor({ gameId, board }: { gameId: string; board: TeamBoard }) {
  return (
    <form action={setLineup} className="space-y-2">
      <input type="hidden" name="game_id" value={gameId} />
      <input type="hidden" name="team_id" value={board.id} />
      <p className="text-muted-foreground text-xs font-semibold uppercase">
        Lineup
      </p>
      <div className="flex flex-wrap gap-1.5">
        {board.roster.map((p) => (
          <label
            key={p.playerId}
            className="border-input has-[:checked]:bg-secondary has-[:checked]:border-secondary-foreground/30 flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-sm font-medium tabular-nums select-none"
          >
            <input
              type="checkbox"
              name="player_ids"
              value={p.playerId}
              defaultChecked={p.dressed}
            />
            {p.number ?? "—"}
          </label>
        ))}
      </div>
      <Button type="submit" size="sm" variant="secondary">
        Save lineup
      </Button>
    </form>
  );
}

function TeamPanel({ data, board }: { data: ScoreBoardData; board: TeamBoard }) {
  // Scorekeeper/manager can edit even after the game is completed (to fix
  // mistakes); captains can only set the lineup before it's finalized.
  const editStats = data.canScore;
  const editLineup =
    data.canScore || (!data.finalized && data.captainTeamId === board.id);
  const total = board.dressed.reduce((s, l) => s + l.goals, 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <TeamLogo name={board.name} color={board.color} />
            {board.name}
          </CardTitle>
          {data.canScore ? (
            <span className="text-2xl font-bold tabular-nums">{total}</span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {editLineup ? <LineupEditor gameId={data.gameId} board={board} /> : null}

        {data.canScore ? (
          board.dressed.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No players in the lineup yet.
            </p>
          ) : (
            <div>
              <div className="text-muted-foreground flex items-center gap-3 border-b pb-1 text-[0.7rem] font-semibold uppercase">
                <span className="w-10 shrink-0">#</span>
                <div className="flex items-center gap-2">
                  {STAT_COLS.map((s) => (
                    <span key={s.col} className="w-24 text-center">
                      {s.label}
                    </span>
                  ))}
                </div>
              </div>
              <div className="divide-y">
                {board.dressed.map((line) => (
                  <div key={line.rosterId} className="flex items-center gap-3 py-1.5">
                    <span className="w-10 shrink-0 text-lg font-bold tabular-nums">
                      {line.number ?? "—"}
                    </span>
                    <div className="flex items-center gap-2">
                      {STAT_COLS.map((s) => (
                        <StatCell
                          key={s.col}
                          gameId={data.gameId}
                          rosterId={line.rosterId}
                          col={s.col}
                          value={line[s.col]}
                          editable={editStats}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ScoreBoard({ data }: { data: ScoreBoardData }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-4">
        <div className="flex items-center gap-4">
          <GameStatusBadge status={data.status} />
          {data.canScore ? (
            <span className="text-lg font-semibold tabular-nums">
              {data.awayName} {data.awayScore} – {data.homeScore} {data.homeName}
            </span>
          ) : (
            <span className="text-lg font-semibold">
              {data.awayName} @ {data.homeName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data.canScore && !data.finalized ? (
            <form action={finalizeGame}>
              <input type="hidden" name="game_id" value={data.gameId} />
              <Button type="submit">Complete game</Button>
            </form>
          ) : null}
          {data.canScore && data.finalized ? (
            <form action={reopenGame}>
              <input type="hidden" name="game_id" value={data.gameId} />
              <Button type="submit" variant="outline">
                Reopen
              </Button>
            </form>
          ) : null}
        </div>
      </div>

      {data.canScore ? (
        <p className="text-muted-foreground text-sm">
          {data.finalized
            ? "This game is complete. You can still adjust the lineup or any number — changes save and update the standings and stats."
            : "Check the lineup, then tap − / + to adjust each number's goals, assists, and penalty minutes by one. Press Complete game when it's over."}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {data.boards.map((b) => (
          <TeamPanel key={b.id} data={data} board={b} />
        ))}
      </div>
    </div>
  );
}

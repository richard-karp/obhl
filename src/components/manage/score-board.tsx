import {
  setLineup,
  bumpStat,
  finalizeGame,
  reopenGame,
  setGoalie,
  bumpEmptyNet,
  setSubstitutes,
} from "@/lib/actions/games";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GameStatusBadge } from "@/components/shared/game-status-badge";
import { TeamLogo } from "@/components/shared/team-logo";

export type DressedLine = {
  rosterId: string;
  playerId: string | null;
  /** True for the single aggregate "Substitute" row (no individual player). */
  isSub: boolean;
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
  side: "home" | "away";
  name: string;
  color: string | null;
  /** `teams.logo_path` — the uploaded crest, or null for the monogram chip. */
  logoPath: string | null;
  /** `teams.logo_text_color` — which ink the monogram uses. */
  logoTextColor: string | null;
  dressed: DressedLine[];
  roster: RosterCheck[];
  /**
   * Rostered goalies (position='G') — the only choices for goalie of record.
   *
   * ⚠️ `night` is carried but not rendered. This board offers every goalie and
   * lets the scorekeeper pick; the night is what `suggestGoalie` already used
   * to choose `suggestedGoalieId` below, and showing it beside a number the
   * scorekeeper is matching against a jersey would be noise. It replaced
   * `isDefault`, which was equally unread — 0049 dropped the flag behind it.
   */
  goalies: { playerId: string; number: number | null; night: number | null }[];
  /**
   * Who to pre-select: the team's only goalie, else the one whose night this
   * is, else nobody. See `src/lib/goalie/suggest.ts` — the rule is there and
   * tested, not here.
   */
  suggestedGoalieId: string | null;
  /** Goalie of record (explicit pick); null falls back to the dressed goalie. */
  goalieId: string | null;
  /** True when the goalie of record was a substitute — no individual GA/W-L. */
  goalieIsSub: boolean;
  /** Empty-net goals scored against this team — excluded from its goalie GAA. */
  emptyNetAgainst: number;
};
export type ScoreBoardData = {
  gameId: string;
  /**
   * What `finalizeGame` refused this sheet over, one line per problem, empty
   * when it has not refused. See `lib/games/incomplete.ts`.
   */
  problems: string[];
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
  const hasSub = board.dressed.some((l) => l.isSub);
  return (
    <div className="space-y-2">
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
      <form action={setSubstitutes}>
        <input type="hidden" name="game_id" value={gameId} />
        <input type="hidden" name="team_id" value={board.id} />
        <input type="hidden" name="present" value={hasSub ? "0" : "1"} />
        <Button type="submit" size="sm" variant="ghost" className="h-7 text-xs">
          {hasSub ? "− Remove substitutes" : "+ Add substitutes row"}
        </Button>
      </form>
    </div>
  );
}

/** Goalie of record + empty-net-goals-against (scorekeeper/manager/captain). */
function GoalieAndEmptyNet({
  data,
  board,
}: {
  data: ScoreBoardData;
  board: TeamBoard;
}) {
  // Explicit pick takes priority; fall back to the configured suggestion.
  // ⛔ A SUGGESTION IS NOT A SELECTION, AND CONFLATING THEM COSTS A GOALIE THEIR
  // GAME. `suggestedGoalieId` is a hint from the day's rota or the team default;
  // nobody has confirmed it. It used to be harmless to draw it as selected,
  // because dressing everyone via the lineup checkboxes gave `v_goalie_stats` its
  // dressed-G fallback either way. Goalies left those checkboxes, so `setGoalie`
  // is now the ONLY thing that creates their `game_rosters` row — and it runs
  // only on an explicit tap. A scorekeeper who sees a filled button and moves on
  // leaves `home_goalie_id` null AND no dressed goalie, so both branches of
  // `v_goalie_stats` miss and the goalie gets no GP, no GAA, no W/L.
  const isSet = board.goalieId != null;
  const activeValue = isSet
    ? board.goalieIsSub
      ? "sub"
      : board.goalieId
    : (board.suggestedGoalieId ?? "");
  const options: { value: string; label: string }[] = [
    ...board.goalies.map((g) => ({
      value: g.playerId,
      label: `#${g.number ?? "—"}`,
    })),
    { value: "sub", label: "Sub" },
  ];
  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <div className="space-y-1">
          <span className="text-muted-foreground block text-[0.7rem] font-semibold uppercase">
            Goalie
          </span>
          <div className="flex flex-wrap gap-1.5">
            {options.map((opt) => (
              <form key={opt.value} action={setGoalie}>
                <input type="hidden" name="game_id" value={data.gameId} />
                <input type="hidden" name="side" value={board.side} />
                <input type="hidden" name="goalie_id" value={opt.value} />
                <Button
                  type="submit"
                  size="sm"
                  // Filled = confirmed. Muted = suggested but NOT yet set, so
                  // it reads as "probably this one, tap to confirm" rather than
                  // as done.
                  variant={
                    activeValue === opt.value
                      ? isSet
                        ? "default"
                        : "secondary"
                      : "outline"
                  }
                  className="h-7 tabular-nums"
                >
                  {opt.label}
                </Button>
              </form>
            ))}
          </div>
        </div>

        {data.canScore ? (
          <div className="space-y-1">
            <span className="text-muted-foreground block text-[0.7rem] font-semibold uppercase">
              Empty-net goals
            </span>
            <div className="flex items-center gap-1.5">
              <EmptyNetButton gameId={data.gameId} side={board.side} sign="−" />
              <span className="w-5 text-center text-sm font-semibold tabular-nums">
                {board.emptyNetAgainst}
              </span>
              <EmptyNetButton gameId={data.gameId} side={board.side} sign="+" />
            </div>
          </div>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        Tap a goalie to set who&apos;s in net (W/L credit). &quot;Sub&quot; =
        substitute goalie, no individual stats.
        {data.canScore
          ? " Empty-net goals = goals scored against an empty net — excluded from the goalie’s GAA."
          : ""}
      </p>
    </div>
  );
}

function EmptyNetButton({
  gameId,
  side,
  sign,
}: {
  gameId: string;
  side: string;
  sign: "+" | "−";
}) {
  return (
    <form action={bumpEmptyNet}>
      <input type="hidden" name="game_id" value={gameId} />
      <input type="hidden" name="side" value={side} />
      <input type="hidden" name="delta" value={sign === "+" ? "1" : "-1"} />
      <Button
        type="submit"
        variant="outline"
        size="icon"
        className="size-7 text-base leading-none"
        aria-label={`${sign === "+" ? "Add" : "Remove"} empty-net goal against ${side}`}
      >
        {sign}
      </Button>
    </form>
  );
}

function TeamPanel({
  data,
  board,
}: {
  data: ScoreBoardData;
  board: TeamBoard;
}) {
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
            <TeamLogo
              name={board.name}
              color={board.color}
              logoPath={board.logoPath}
              textColor={board.logoTextColor}
            />
            {board.name}
          </CardTitle>
          {data.canScore ? (
            <span className="text-2xl font-bold tabular-nums">{total}</span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {editLineup ? (
          <LineupEditor gameId={data.gameId} board={board} />
        ) : null}

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
                  <div
                    key={line.rosterId}
                    data-testid="dressed-line"
                    className="flex items-center gap-3 py-1.5"
                  >
                    <span className="w-10 shrink-0 text-lg font-bold tabular-nums">
                      {line.isSub ? (
                        <span className="text-xs uppercase">Subs</span>
                      ) : (
                        (line.number ?? "—")
                      )}
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

        {editLineup ? <GoalieAndEmptyNet data={data} board={board} /> : null}
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
              {data.awayName} {data.awayScore} – {data.homeScore}{" "}
              {data.homeName}
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
              {/*
                ⛔ `confirm` IS ONLY SENT ONCE THE ACTION HAS ALREADY REFUSED.
                Pre-filling it on the first press would turn the gate into a
                no-op — the action would never see an unconfirmed submit and
                the warning below would never be reached.
              */}
              {data.problems.length > 0 ? (
                <input type="hidden" name="confirm" value="1" />
              ) : null}
              <Button type="submit">
                {data.problems.length > 0 ? "Complete anyway" : "Complete game"}
              </Button>
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

      {/*
        ⛔ IT NAMES WHAT IS MISSING, BY TEAM. "Something is wrong" would be read
        past exactly the way the muted goalie button was — production shipped
        three games with four goalies and one whole lineup unrecorded, and the
        scorekeeper had no way to see it from this page. The list is the fix;
        the second press is the acknowledgement.
      */}
      {data.problems.length > 0 ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 space-y-2 rounded-lg border p-4"
        >
          <p className="text-sm font-semibold">
            This game is not finished being entered.
          </p>
          <ul className="text-muted-foreground list-disc space-y-0.5 pl-5 text-sm">
            {data.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            A missing goalie means no GP, no GAA and no W/L for them all
            season. Fix it below, or press{" "}
            <strong className="text-foreground">Complete anyway</strong> if
            that is really how the game went.
          </p>
        </div>
      ) : null}

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

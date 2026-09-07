"use client";

import { useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  exchangeSlots,
  exchangeTeams,
  replacementOptions,
  retimeGame,
} from "@/lib/actions/schedule-edits";

/**
 * The manager's manual edits to a schedule that already exists.
 *
 * ⛔ EVERY OPERATION HERE IS A TRADE, and that is not a UI choice — it follows
 * from the user's constraint that total games per team and games per night are
 * non-negotiable. Replacing a team on its own leaves one side a game short
 * forever; moving a game to another night robs the night it left. So "replace a
 * team" asks a second question (who gives the place back) and writes two rows,
 * and a night change is a trade with a game already on the target night.
 *
 * ⚠️ Rendered ONLY where `canManageLeague` is true. This panel sits on the
 * public schedule page, which scorekeepers also read — see that page's own note
 * about `canScore` admitting two of three roles. Gate on management, never on
 * scoring.
 */
export type EditableGame = {
  id: string;
  label: string;
  night: string;
  /** "YYYY-MM-DDTHH:MM" in league time, for the retime field's default. */
  localAt: string;
  homeId: string;
  awayId: string;
  homeName: string;
  awayName: string;
};

export type TeamOption = { id: string; name: string };

export function ScheduleEditPanel({
  games,
  teams,
}: {
  games: EditableGame[];
  teams: TeamOption[];
}) {
  if (games.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Change this schedule</CardTitle>
      </CardHeader>
      <CardContent className="space-y-8">
        <p className="text-muted-foreground text-sm">
          Every change here is a trade, so the schedule keeps the same number of
          games for each team and on each night. Nothing is re-optimised — bye
          spacing and ice-time share stay exactly as they are.
        </p>
        <ReplaceTeam games={games} teams={teams} />
        <TradeTeams games={games} />
        <TradeNights games={games} />
        <Retime games={games} />
      </CardContent>
    </Card>
  );
}

/** Shared plumbing: run a server action, show what it said. */
function useEdit() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (
    fn: () => Promise<{ ok: boolean; message?: string }>,
    done: string,
  ) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      setMsg(
        r.ok
          ? { ok: true, text: done }
          : { ok: false, text: r.message ?? "That did not work." },
      );
    });
  return { pending, msg, setMsg, run };
}

function Note({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return (
    <p
      className={
        msg.ok
          ? "text-sm text-emerald-600 dark:text-emerald-400"
          : "text-destructive text-sm"
      }
    >
      {msg.text}
    </p>
  );
}

function GamePicker({
  id,
  label,
  games,
  value,
  onChange,
}: {
  id: string;
  label: string;
  games: EditableGame[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Pick a game…</option>
        {games.map((g) => (
          <option key={g.id} value={g.id}>
            {g.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function TeamPicker({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  options: TeamOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Pick a team…</option>
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Replace a team — a wizard, because a replacement on its own is not a legal
 * schedule. Step 2 lists the games where the arriving team can hand its place
 * back; an empty list is a refusal with the reason, never a one-sided write.
 */
function ReplaceTeam({
  games,
  teams,
}: {
  games: EditableGame[];
  teams: TeamOption[];
}) {
  const { pending, msg, setMsg, run } = useEdit();
  const [gameId, setGameId] = useState("");
  const [teamOut, setTeamOut] = useState("");
  const [teamIn, setTeamIn] = useState("");
  const [options, setOptions] = useState<
    { id: string; label: string }[] | null
  >(null);

  const game = games.find((g) => g.id === gameId);
  const inThisGame = game
    ? [
        { id: game.homeId, name: game.homeName },
        { id: game.awayId, name: game.awayName },
      ]
    : [];

  const find = () =>
    run(async () => {
      const r = await replacementOptions({ gameId, teamOut, teamIn });
      setOptions(r.ok ? r.games : null);
      return r.ok ? { ok: true } : r;
    }, "Pick the game that gives the place back.");

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Replace a team in a game</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <GamePicker
          id="rt-game"
          label="Game"
          games={games}
          value={gameId}
          onChange={(v) => {
            setGameId(v);
            setTeamOut("");
            setOptions(null);
            setMsg(null);
          }}
        />
        <TeamPicker
          id="rt-out"
          label="Team leaving"
          options={inThisGame}
          value={teamOut}
          onChange={setTeamOut}
        />
        <TeamPicker
          id="rt-in"
          label="Team arriving"
          options={teams.filter(
            (t) => t.id !== game?.homeId && t.id !== game?.awayId,
          )}
          value={teamIn}
          onChange={setTeamIn}
        />
      </div>
      <Button
        size="sm"
        variant="secondary"
        disabled={!gameId || !teamOut || !teamIn || pending}
        onClick={find}
      >
        Find the swap
      </Button>
      {options ? (
        <div className="space-y-2 border-l-2 pl-3">
          <p className="text-muted-foreground text-sm">
            Choose the game where the two teams trade back:
          </p>
          {options.map((o) => (
            <div key={o.id} className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      exchangeTeams({
                        gameX: gameId,
                        teamOutX: teamOut,
                        gameY: o.id,
                        teamOutY: teamIn,
                      }),
                    "Swapped.",
                  )
                }
              >
                {o.label}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <Note msg={msg} />
    </section>
  );
}

/** Two games trade a participant — the "the two of us agreed to switch" case. */
function TradeTeams({ games }: { games: EditableGame[] }) {
  const { pending, msg, run } = useEdit();
  const [x, setX] = useState("");
  const [y, setY] = useState("");
  const [outX, setOutX] = useState("");
  const [outY, setOutY] = useState("");
  const gx = games.find((g) => g.id === x);
  const gy = games.find((g) => g.id === y);
  const sides = (g?: EditableGame) =>
    g
      ? [
          { id: g.homeId, name: g.homeName },
          { id: g.awayId, name: g.awayName },
        ]
      : [];

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Trade teams between two games</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <GamePicker
          id="tt-x"
          label="First game"
          games={games}
          value={x}
          onChange={(v) => {
            setX(v);
            setOutX("");
          }}
        />
        <TeamPicker
          id="tt-outx"
          label="Team leaving it"
          options={sides(gx)}
          value={outX}
          onChange={setOutX}
        />
        <GamePicker
          id="tt-y"
          label="Second game"
          games={games.filter((g) => g.id !== x)}
          value={y}
          onChange={(v) => {
            setY(v);
            setOutY("");
          }}
        />
        <TeamPicker
          id="tt-outy"
          label="Team leaving it"
          options={sides(gy)}
          value={outY}
          onChange={setOutY}
        />
      </div>
      <Button
        size="sm"
        variant="secondary"
        disabled={!x || !y || !outX || !outY || pending}
        onClick={() =>
          run(
            () =>
              exchangeTeams({
                gameX: x,
                teamOutX: outX,
                gameY: y,
                teamOutY: outY,
              }),
            "Traded.",
          )
        }
      >
        Trade these two
      </Button>
      <Note msg={msg} />
    </section>
  );
}

/** Two games trade dates. The only way to move a game to another night. */
function TradeNights({ games }: { games: EditableGame[] }) {
  const { pending, msg, run } = useEdit();
  const [x, setX] = useState("");
  const [y, setY] = useState("");
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Trade nights between two games</h3>
      <p className="text-muted-foreground text-xs">
        Moving one game on its own would leave one night a game short and
        another a game long, so nights are swapped in pairs.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <GamePicker
          id="tn-x"
          label="This game"
          games={games}
          value={x}
          onChange={setX}
        />
        <GamePicker
          id="tn-y"
          label="Swaps nights with"
          games={games.filter((g) => g.id !== x)}
          value={y}
          onChange={setY}
        />
      </div>
      <Button
        size="sm"
        variant="secondary"
        disabled={!x || !y || pending}
        onClick={() =>
          run(() => exchangeSlots({ gameX: x, gameY: y }), "Nights traded.")
        }
      >
        Swap their nights
      </Button>
      <Note msg={msg} />
    </section>
  );
}

/** Move a game's ice time within its own night — the one edit that needs no partner. */
function Retime({ games }: { games: EditableGame[] }) {
  const { pending, msg, run } = useEdit();
  const [id, setId] = useState("");
  const [at, setAt] = useState("");
  const game = games.find((g) => g.id === id);
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Change a game&apos;s ice time</h3>
      <p className="text-muted-foreground text-xs">
        Same night only. A different night is a trade, above.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <GamePicker
          id="rg-game"
          label="Game"
          games={games}
          value={id}
          onChange={(v) => {
            setId(v);
            setAt(games.find((g) => g.id === v)?.localAt ?? "");
          }}
        />
        <div className="space-y-1">
          <Label htmlFor="rg-at">New time</Label>
          <Input
            id="rg-at"
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            disabled={!game}
          />
        </div>
      </div>
      <Button
        size="sm"
        variant="secondary"
        disabled={!id || !at || pending}
        onClick={() =>
          run(() => retimeGame({ gameId: id, at }), "Time changed.")
        }
      >
        Move the time
      </Button>
      <Note msg={msg} />
    </section>
  );
}

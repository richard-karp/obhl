"use client";

import { useState, useActionState } from "react";
import {
  scheduleSpecialGame,
  type ScheduleGameState,
} from "@/lib/actions/schedule";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type TeamOption = { id: string; name: string };

export function ScheduleFinalForm({
  teams,
  seasonId,
}: {
  teams: TeamOption[];
  seasonId: string;
}) {
  const [state, action, pending] = useActionState<ScheduleGameState, FormData>(
    scheduleSpecialGame,
    null,
  );
  const [round, setRound] = useState<"final" | "semifinals">("final");

  const teamSelect = (name: string, label: string) => (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      <select
        id={name}
        name={name}
        required
        defaultValue=""
        className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
      >
        <option value="" disabled>
          Pick a team…
        </option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="season_id" value={seasonId} />
      <div className="space-y-1 sm:max-w-xs">
        <Label htmlFor="round">Round</Label>
        <select
          id="round"
          name="round"
          value={round}
          onChange={(e) => setRound(e.target.value as "final" | "semifinals")}
          className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
        >
          <option value="final">Final (1 game)</option>
          <option value="semifinals">Semifinals (2 games)</option>
        </select>
      </div>

      {round === "final" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {teamSelect("home_team_id", "Team 1")}
          {teamSelect("away_team_id", "Team 2")}
          <div className="space-y-1">
            <Label htmlFor="label">Label</Label>
            <Input id="label" name="label" defaultValue="Final" />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-xs font-semibold uppercase">
              Semifinal 1
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {teamSelect("sf1_home", "Team 1")}
              {teamSelect("sf1_away", "Team 2")}
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-xs font-semibold uppercase">
              Semifinal 2
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {teamSelect("sf2_home", "Team 1")}
              {teamSelect("sf2_away", "Team 2")}
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="date">Date</Label>
          <Input id="date" name="date" type="date" required />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="slots">Ice-time slots</Label>
          <Input id="slots" name="slots" defaultValue="19:00, 20:15, 21:30" />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="fill_others" defaultChecked /> Also schedule
        the other teams that night
      </label>
      <p className="text-muted-foreground text-xs">
        The labeled game{round === "semifinals" ? "s take" : " takes"} the last
        ice time{round === "semifinals" ? "s" : ""}; if checked, the remaining
        teams are paired into games on the earlier slots. Added on top of the
        schedule — the rest of the season isn&apos;t regenerated.
      </p>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Scheduling…" : "Schedule game"}
        </Button>
        {state ? (
          <p
            className={
              state.ok
                ? "text-sm text-emerald-600 dark:text-emerald-400"
                : "text-destructive text-sm"
            }
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

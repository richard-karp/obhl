"use client";

import { useActionState } from "react";
import { addRosterPlayer, type RosterActionState } from "@/lib/actions/rosters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type PersonOption = { id: string; name: string };

export function AddPlayerForm({
  seasonId,
  teamId,
  people,
}: {
  seasonId: string;
  teamId: string;
  people: PersonOption[];
}) {
  const [state, action, pending] = useActionState<RosterActionState, FormData>(
    addRosterPlayer,
    null,
  );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="season_id" value={seasonId} />
      <input type="hidden" name="team_id" value={teamId} />

      {people.length > 0 ? (
        <div className="space-y-1">
          <Label htmlFor="player_id">Existing person (optional)</Label>
          <select
            id="player_id"
            name="player_id"
            defaultValue=""
            className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm sm:max-w-xs"
          >
            <option value="">— New person —</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-xs">
            Pick someone who already plays in another league to reuse their
            profile, or leave as “New person” and enter a name below.
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-6 sm:items-end">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="first_name">First name</Label>
          <Input id="first_name" name="first_name" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="last_name">Last name</Label>
          <Input id="last_name" name="last_name" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="jersey_number">#</Label>
          <Input id="jersey_number" name="jersey_number" type="number" min="0" max="99" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="position">Pos</Label>
          <select
            id="position"
            name="position"
            className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
            defaultValue="F"
          >
            <option value="F">F</option>
            <option value="D">D</option>
            <option value="G">G</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="is_captain" /> Captain
        </label>
        <div className="flex items-center gap-3 sm:col-span-4">
          <Button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Add player"}
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
      </div>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import {
  createTeamForSeason,
  type TeamActionState,
} from "@/lib/actions/seasons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AddTeamForm({ seasonId }: { seasonId: string }) {
  const [state, action, pending] = useActionState<TeamActionState, FormData>(
    createTeamForSeason,
    null,
  );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="season_id" value={seasonId} />
      <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="name">Team name</Label>
          <Input id="name" name="name" required placeholder="Sharks" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="color">Color</Label>
          <Input
            id="color"
            name="color"
            type="color"
            defaultValue="#0ea5e9"
            className="h-9 w-full p-1"
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="captain_name">Captain name (optional)</Label>
          <Input id="captain_name" name="captain_name" placeholder="Sam Rivera" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="captain_email">Captain email (optional)</Label>
          <Input
            id="captain_email"
            name="captain_email"
            type="email"
            placeholder="sam@example.com"
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Adding a captain name makes them the team captain. Add their email too and
        a captain login is created so they can sign in and set lineups. The rest
        of the roster can be added later — it&apos;s not required here.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add team"}
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

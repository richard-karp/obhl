"use client";

import { useActionState, useState } from "react";
import {
  updatePlayerName,
  updateRosterPlayer,
  type RosterActionState,
} from "@/lib/actions/rosters";
import { Button } from "@/components/ui/button";

/**
 * The two edits a roster row can carry, kept visibly apart because they are not
 * the same kind of change.
 *
 * ⚠️ NUMBER AND POSITION ARE THIS TEAM'S; THE NAME IS EVERYONE'S. Jersey and
 * position live on `team_players` — one team, one season — while a name lives on
 * `players`, which has no league at all (0002_core.sql:43). One row, shared by
 * every league that person plays in. So the rename sits in its own block, with
 * its own button, under copy that says where the change lands. Folding the three
 * fields into one Save would hide a cross-league write inside a routine one.
 */
export function EditPlayerForm({
  rosterId,
  firstName,
  lastName,
  jerseyNumber,
  position,
}: {
  rosterId: string;
  firstName: string;
  lastName: string;
  jerseyNumber: number | null;
  position: string;
}) {
  const [open, setOpen] = useState(false);
  const [rosterState, rosterAction, rosterPending] = useActionState<
    RosterActionState,
    FormData
  >(updateRosterPlayer, null);
  const [nameState, nameAction, namePending] = useActionState<
    RosterActionState,
    FormData
  >(updatePlayerName, null);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
    );
  }

  return (
    <div className="bg-muted/30 basis-full space-y-3 rounded-md border p-3 text-left">
      <form action={rosterAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={rosterId} />
        <div className="space-y-1">
          <label
            className="text-muted-foreground block text-xs"
            htmlFor={`num-${rosterId}`}
          >
            Number
          </label>
          <input
            id={`num-${rosterId}`}
            name="jersey_number"
            type="number"
            min={0}
            max={99}
            defaultValue={jerseyNumber ?? ""}
            disabled={rosterPending}
            className="h-8 w-16 rounded-md border px-2 text-xs"
          />
        </div>
        <div className="space-y-1">
          <label
            className="text-muted-foreground block text-xs"
            htmlFor={`pos-${rosterId}`}
          >
            Position
          </label>
          <select
            id={`pos-${rosterId}`}
            name="position"
            defaultValue={position}
            disabled={rosterPending}
            className="border-input bg-background h-8 rounded-md border px-2 text-xs"
          >
            <option value="F">F</option>
            <option value="D">D</option>
            <option value="G">G</option>
          </select>
        </div>
        <Button type="submit" size="sm" disabled={rosterPending}>
          {rosterPending ? "Saving…" : "Save"}
        </Button>
        {rosterState ? (
          <p
            role="status"
            className={
              rosterState.ok
                ? "basis-full text-xs text-emerald-600 dark:text-emerald-400"
                : "text-destructive basis-full text-xs"
            }
          >
            {rosterState.message}
          </p>
        ) : null}
      </form>

      <form
        action={nameAction}
        className="flex flex-wrap items-end gap-2 border-t pt-3"
      >
        <input type="hidden" name="id" value={rosterId} />
        <div className="space-y-1">
          <label
            className="text-muted-foreground block text-xs"
            htmlFor={`first-${rosterId}`}
          >
            First name
          </label>
          <input
            id={`first-${rosterId}`}
            name="first_name"
            defaultValue={firstName}
            disabled={namePending}
            className="h-8 w-28 rounded-md border px-2 text-xs"
          />
        </div>
        <div className="space-y-1">
          <label
            className="text-muted-foreground block text-xs"
            htmlFor={`last-${rosterId}`}
          >
            Last name
          </label>
          <input
            id={`last-${rosterId}`}
            name="last_name"
            defaultValue={lastName}
            disabled={namePending}
            className="h-8 w-28 rounded-md border px-2 text-xs"
          />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={namePending}
        >
          {namePending ? "Renaming…" : "Rename everywhere"}
        </Button>
        {/* Said before the button is pressed, not after. A person is one record
            across leagues, and a manager fixing a typo has no way to know from
            this page that the player also skates somewhere else. */}
        <p className="text-muted-foreground basis-full text-xs">
          A player is one record shared by every league they play in, so this
          renames them everywhere — not just here. If they also play a league
          you do not manage, the change is refused and the League Office can
          make it.
        </p>
        {nameState ? (
          <p
            role="status"
            className={
              nameState.ok
                ? "basis-full text-xs text-emerald-600 dark:text-emerald-400"
                : "text-destructive basis-full text-xs"
            }
          >
            {nameState.message}
          </p>
        ) : null}
      </form>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(false)}
      >
        Done
      </Button>
    </div>
  );
}

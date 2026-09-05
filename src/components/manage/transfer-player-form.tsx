"use client";

import { useActionState, useState } from "react";
import { transferPlayer, type RosterActionState } from "@/lib/actions/rosters";
import { Button } from "@/components/ui/button";

export type TransferTeam = { id: string; name: string };

/**
 * Move one player to another team in the same season.
 *
 * Collapsed until asked for, because it sits in a row that already carries five
 * controls and this is the rarest of them. Open, it asks the two things the
 * action cannot decide: which team, and which number — the number defaults to
 * the one they wear now and the server refuses rather than silently blanks it
 * if that is taken.
 */
export function TransferPlayerForm({
  rosterId,
  jerseyNumber,
  teams,
}: {
  rosterId: string;
  jerseyNumber: number | null;
  /** The season's other teams. The server re-derives the league from all three ids. */
  teams: TransferTeam[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<RosterActionState, FormData>(
    transferPlayer,
    null,
  );

  if (teams.length === 0) return null;

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Transfer
      </Button>
    );
  }

  return (
    <form
      action={action}
      className="flex flex-wrap items-center justify-end gap-1"
    >
      <input type="hidden" name="id" value={rosterId} />
      <label className="sr-only" htmlFor={`to-team-${rosterId}`}>
        To team
      </label>
      <select
        id={`to-team-${rosterId}`}
        name="to_team_id"
        required
        defaultValue=""
        disabled={pending}
        className="border-input bg-background h-8 rounded-md border px-2 text-xs"
      >
        <option value="" disabled>
          To team…
        </option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor={`jersey-${rosterId}`}>
        Jersey number
      </label>
      <input
        id={`jersey-${rosterId}`}
        name="jersey_number"
        type="number"
        min={0}
        defaultValue={jerseyNumber ?? ""}
        placeholder="#"
        disabled={pending}
        className="h-8 w-14 rounded-md border px-2 text-xs"
      />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Transferring…" : "Confirm transfer"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(false)}
        disabled={pending}
      >
        Cancel
      </Button>
      {state && !state.ok ? (
        <p
          role="status"
          className="text-destructive basis-full text-right text-xs"
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

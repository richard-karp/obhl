"use client";

import { useActionState } from "react";
import { rescheduleGame } from "@/lib/actions/games";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The reschedule control on a scoresheet.
 *
 * ⛔ THIS IS A CLIENT COMPONENT FOR ONE REASON: `rescheduleGame` REFUSES. It
 * refuses a game that has been played, and it refuses a move to a different
 * night — the second is a rule the card states in prose right above this form,
 * so a manager reaching it is doing something the page invited them to try.
 * As a plain `<form action={…}>` those refusals could only be thrown, and a
 * throw from a server action lands in `app/error.tsx`: the entire scoresheet is
 * replaced by "Something went wrong", and the sentence explaining what to do
 * instead is never shown to the person it was written for.
 */
export function RescheduleForm({ gameId }: { gameId: string }) {
  const [state, action, pending] = useActionState(rescheduleGame, null);

  return (
    <form action={action} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="game_id" value={gameId} />
        <div className="space-y-1">
          <Label htmlFor="scheduled_at">Reschedule to</Label>
          <Input
            id="scheduled_at"
            name="scheduled_at"
            type="datetime-local"
            className="w-56"
          />
        </div>
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          {pending ? "Moving…" : "Reschedule"}
        </Button>
      </div>
      {state && !state.ok ? (
        <p className="text-destructive text-sm">{state.message}</p>
      ) : null}
      {state?.ok ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">Moved.</p>
      ) : null}
    </form>
  );
}

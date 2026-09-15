"use client";

import { useActionState } from "react";
import { rescheduleGame } from "@/lib/actions/games";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ⛔ A client component because `rescheduleGame` refuses: from a plain form action a refusal could only
// throw, replacing the scoresheet with `app/error.tsx` and hiding the explanation.
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

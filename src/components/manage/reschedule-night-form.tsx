"use client";

import { startTransition, useActionState, useEffect } from "react";
import { toast } from "sonner";
import {
  rescheduleNight,
  type RescheduleNightState,
} from "@/lib/actions/schedule";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatLongDate } from "@/lib/format";

export type MovableNight = { date: string; games: number };

const SELECT =
  "border-input bg-background h-9 w-full rounded-md border px-2 text-sm";

// Works on a started season: an in-place `scheduled_at` update that survives `season_is_started`
// (`rescheduleNight`). Only unlocked nights are offered, rather than refused afterwards.
export function RescheduleNightForm({
  seasonId,
  nights,
  minDate,
  maxDate,
}: {
  seasonId: string;
  nights: MovableNight[];
  // Today in the league's zone, computed on the server: the browser's zone is a day off for anyone
  // travelling. The browser half of `checkNightMove`.
  minDate: string;
  /** The season's last day, when it has one. */
  maxDate: string | null;
}) {
  const [state, action, pending] = useActionState<
    RescheduleNightState,
    FormData
  >(rescheduleNight, null);

  useEffect(() => {
    if (!state) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
  }, [state]);

  if (nights.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Every remaining game night has already been played or is in the past, so
        there is none left to move.
      </p>
    );
  }

  // ⛔ Dispatched here, not via `<form action>`: React 19's reset would empty the fields a manager corrects
  // and resubmits after a refusal. `startTransition` is what raises `isPending`.
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = new FormData(e.currentTarget);
    startTransition(() => action(body));
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input type="hidden" name="season_id" value={seasonId} />
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="from_date">Night to move</Label>
          <select
            id="from_date"
            name="from_date"
            className={SELECT}
            defaultValue=""
            required
          >
            <option value="" disabled>
              Pick a night…
            </option>
            {nights.map((n) => (
              <option key={n.date} value={n.date}>
                {formatLongDate(n.date)} · {n.games} game
                {n.games === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="to_date">New date</Label>
          <Input
            id="to_date"
            name="to_date"
            type="date"
            required
            /* ⛔ Only the browser half: `checkNightMove` refuses server-side, since live games moved into the
               past trip `season_is_started` for good. Today in the league's zone, not the browser's. */
            min={minDate}
            max={maxDate ?? undefined}
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Moving…" : "Move night"}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Every game on that night keeps its ice time and its opponents — only the
        date changes, and the games keep their ids, so team calendar feeds
        update rather than resubscribe. A date that already has games is
        refused: combining two nights is an ice-booking decision this can&apos;t
        make.
      </p>
    </form>
  );
}

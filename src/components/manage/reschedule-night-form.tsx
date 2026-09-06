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

/**
 * Move a whole game night to another date.
 *
 * Deliberately available on a season that has already started: this is an
 * in-place update of the games' `scheduled_at`, so it takes the write path that
 * survives `season_is_started` — see `rescheduleNight` for why that matters.
 *
 * Only unlocked nights are offered. A locked one would be refused by the action
 * with a message naming the game that locked it, but offering a night that
 * cannot move and explaining afterwards is the worse of the two.
 */
export function RescheduleNightForm({
  seasonId,
  nights,
  minDate,
  maxDate,
}: {
  seasonId: string;
  nights: MovableNight[];
  /**
   * The earliest date the picker offers: today in the LEAGUE's zone, computed
   * on the server. Not `new Date()` in the browser — that is the viewer's zone,
   * which disagrees by a day for anyone travelling, and this bound is the
   * browser half of a guard whose other half is `checkNightMove`.
   */
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

  /**
   * ⛔ DISPATCHED HERE, NOT VIA `<form action={…}>` — the same React 19 reset
   * that this branch fixed on the generate form, and it bites harder here.
   * Every refusal this action returns is one the manager is expected to correct
   * and resubmit ("that date already runs 3 games"), and the auto-reset emptied
   * both fields on the way out — so the correction went in against a blank
   * night picker and came back "Pick a night to move." Measured 2026-09-06: the
   * refusal landed, the form cleared, and the retry refused for a different
   * reason than the one on screen.
   *
   * `startTransition` is required, not decorative: `useActionState`'s dispatcher
   * only raises `isPending` when called inside one.
   */
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
            /*
              ⛔ The browser half of the one-way-door guard, and it is only the
              half: a client can drop the attribute, so `checkNightMove` refuses
              the same date server-side. Moving live games into the past trips
              `season_is_started` permanently and cannot be undone through this
              form, because the night then reads as locked.

              Today, in the LEAGUE's zone — not the browser's, which would
              disagree by a day for anyone travelling. Same call the generate
              form's first-game-night field makes.
            */
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

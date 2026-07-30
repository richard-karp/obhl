"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { publishSchedule, type PublishState } from "@/lib/actions/schedule";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Publish, or replace. Only a replace destroys anything, so only a replace is
 * confirmed — a season's first publish stays one click.
 *
 * The panel does not render this at all on a started season; see the mode gate
 * in schedule-builder-panel.tsx.
 */
export function PublishControls({
  seasonId,
  draftCount,
  liveCount,
  firstLiveDate,
  lastLiveDate,
  lineupsAtRisk,
  destructive,
}: {
  seasonId: string;
  draftCount: number;
  liveCount: number;
  firstLiveDate: string | null;
  lastLiveDate: string | null;
  lineupsAtRisk: number;
  /** True in "replace" mode — a live schedule would be deleted. */
  destructive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<PublishState, FormData>(
    publishSchedule,
    null,
  );

  // Toasting is a side effect on an external system (sonner), so it belongs in
  // an effect. Closing the dialog is ordinary React state, though, and
  // `react-hooks/set-state-in-effect` is right to reject setting it from here —
  // it's derived from `state` and belongs in render, not synchronized after the
  // fact. See `dialogOpen` below.
  useEffect(() => {
    if (!state) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
  }, [state]);

  // `open` is the user's intent (opened via the button, closed via Cancel/Esc),
  // and a successful replace overrides it shut without its own setState call.
  //
  // Load-bearing precondition: `open` itself is never reset back to false on
  // success, so this derivation is only correct for as long as the component
  // is guaranteed to unmount afterward — which it is today (a success drops
  // draftCount to 0, and the caller keys this component on draftCount, so it
  // remounts with fresh state). If a future caller ever keeps this component
  // mounted across a successful publish/replace (e.g. by rendering it outside
  // the "has drafts" branch, or without the key), `open` would stay stuck
  // `true` forever: the trigger's `setOpen(true)` becomes a no-op against the
  // value it already holds, so `dialogOpen` never re-derives to true and the
  // button goes permanently inert with no dialog and no feedback. Keep the
  // `key={publish.draftCount}` on the call site in schedule-builder-panel.tsx,
  // or reintroduce an explicit reset, if that assumption ever stops holding.
  const dialogOpen = open && !state?.ok;

  const range =
    firstLiveDate && lastLiveDate ? ` (${firstLiveDate} – ${lastLiveDate})` : "";

  if (!destructive) {
    return (
      <form action={action}>
        <input type="hidden" name="season_id" value={seasonId} />
        <Button type="submit" disabled={pending}>
          {pending ? "Publishing…" : `Publish ${draftCount} games`}
        </Button>
      </form>
    );
  }

  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Replace published schedule
      </Button>
      <Dialog open={dialogOpen} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace the published schedule?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This deletes {liveCount} live games{range} and publishes the{" "}
                  {draftCount}-game draft in their place.
                </p>
                <p>Team calendar feeds will change.</p>
                {lineupsAtRisk > 0 ? (
                  <p>
                    {lineupsAtRisk} lineup entries already set for those games
                    will be deleted with them.
                  </p>
                ) : null}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <form action={action}>
              <input type="hidden" name="season_id" value={seasonId} />
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending ? "Replacing…" : "Replace"}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

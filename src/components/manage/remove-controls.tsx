"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { removeSchedule, type RemoveState } from "@/lib/actions/schedule";
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
 * Delete the published schedule outright, leaving the season with no games.
 *
 * Separate from PublishControls rather than a third branch inside it: that
 * component already forks on `destructive` between two quite different renders,
 * and this action publishes nothing. One component answering two unrelated
 * questions is how that fork got hard to read in the first place.
 *
 * The panel renders this only in "published" mode — live games, no draft, season
 * not started. Deliberately not in "replace": the RPC touches only
 * `not is_draft`, so a draft survives a removal, and the dialog below would be
 * telling a manager who already has one that the season has no games until they
 * generate another. Replace is the operation for that case.
 *
 * The dialog is short on purpose. Removal is reachable only before the season
 * starts, so no game has been played, no result exists, and the games are
 * regenerable from the form above — a games count and a calendar-feed warning
 * would be borrowed ceremony describing a cost that isn't paid. Lineups are the
 * exception: `game_rosters` cascades on game delete, and a captain's lineup does
 * not come back when the schedule is regenerated. That is the one line worth a
 * manager's attention, so it is the only detail here.
 */
export function RemoveControls({
  seasonId,
  lineupsAtRisk,
}: {
  seasonId: string;
  lineupsAtRisk: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<RemoveState, FormData>(
    removeSchedule,
    null,
  );

  useEffect(() => {
    if (!state) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
  }, [state]);

  // Same derivation as PublishControls, and the same load-bearing precondition:
  // `open` is never reset to false on success, so this is correct only while the
  // component is guaranteed to unmount afterwards. It is — a successful removal
  // drops liveCount to 0, which moves the season to "empty" or "draft-only", and
  // the panel renders this control in neither. The caller keys on liveCount so
  // that stays true even if the mode boundaries move later. Read the longer
  // comment on `dialogOpen` in publish-controls.tsx before changing either.
  const dialogOpen = open && !state?.ok;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Remove published schedule
      </Button>
      <Dialog open={dialogOpen} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove the published schedule?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  The season will have no games until you generate and publish a
                  new one.
                </p>
                {lineupsAtRisk > 0 ? (
                  <p>
                    {lineupsAtRisk} lineup entries captains have already set will
                    be deleted. The games can be regenerated; those cannot.
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
                {pending ? "Removing…" : "Remove"}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

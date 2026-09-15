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

// Only in "published" mode: the RPC touches `not is_draft`, so beside a draft this dialog would be wrong.
// Lineups are the one cost worth stating: `game_rosters` cascades, and regenerating does not restore them.
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

  // Same derivation as PublishControls: `open` is never reset, so this holds only while a success unmounts
  // this component (the caller keys it on liveCount).
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
                    {lineupsAtRisk} lineup entries captains have already set
                    will be deleted. The games can be regenerated; those cannot.
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

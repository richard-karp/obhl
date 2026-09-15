"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { publishSchedule, type PublishState } from "@/lib/actions/schedule";
import { RedateDraftButton } from "@/components/manage/redate-draft-button";
import type { StaleNotice } from "@/components/manage/stale-draft-notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// A replace or a stale draft confirms: a stale publish locks the season for good. ⚠️ Confirmed, not refused:
// games really played Tuesday must publish Thursday, told the cost and offered the way out.
export function PublishControls({
  seasonId,
  draftCount,
  liveCount,
  liveRange,
  lineupsAtRisk,
  destructive,
  stale,
}: {
  seasonId: string;
  draftCount: number;
  liveCount: number;
  /** The live date range, formatted by the panel; null when no live game has a date. */
  liveRange: string | null;
  lineupsAtRisk: number;
  /** True in "replace" mode — a live schedule would be deleted. */
  destructive: boolean;
  /** Null while the first game is ahead; the same object the warning banner renders. */
  stale: StaleNotice | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<PublishState, FormData>(
    publishSchedule,
    null,
  );

  // Toasting is a side effect, so it lives in an effect; closing the dialog is derived in render (`dialogOpen`).
  useEffect(() => {
    if (!state) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
  }, [state]);

  // `open` is never reset on success: correct only while a success unmounts this (the call site keys on
  // `draftCount`), or the trigger goes inert. ⛔ Never add the stale night to that key: it eats the refusal toast.

  const range = liveRange ? ` (${liveRange})` : "";
  const confirms = destructive || !!stale;

  // ⛔ Reset `open` when the reason to confirm goes away: a re-date unmounts `<Dialog>` without `onOpenChange`,
  // and it would later reopen unclicked. ⚠️ During render; in an effect it is an eslint error.
  const [wasConfirming, setWasConfirming] = useState(confirms);
  if (wasConfirming !== confirms) {
    setWasConfirming(confirms);
    if (!confirms) setOpen(false);
  }

  const dialogOpen = open && !state?.ok;

  if (!confirms) {
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
      <Button
        variant={destructive ? "destructive" : "default"}
        onClick={() => setOpen(true)}
      >
        {destructive
          ? "Replace published schedule"
          : `Publish ${draftCount} games`}
      </Button>
      <Dialog open={dialogOpen} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {stale
                ? "Publish a schedule that starts in the past?"
                : "Replace the published schedule?"}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                {stale ? (
                  <>
                    <p>
                      This draft&apos;s first game night (
                      {stale.firstNightLabel}) has already been played over
                      {stale.passedNights > 1
                        ? `, along with ${stale.passedNights - 1} more`
                        : ""}
                      .
                    </p>
                    <p>
                      Publishing it starts the season in the past, which locks
                      it immediately: the schedule can never be regenerated,
                      replaced or removed. There is no undo.
                    </p>
                    <p>
                      Publish anyway only if those games were really played —
                      otherwise move the draft forward to {stale.shiftedLabel},
                      which keeps every matchup, night and ice time as it is.
                    </p>
                  </>
                ) : null}
                {destructive ? (
                  <>
                    <p>
                      This deletes {liveCount} live games{range} and publishes
                      the {draftCount}-game draft in their place.
                    </p>
                    <p>Team calendar feeds will change.</p>
                    {lineupsAtRisk > 0 ? (
                      <p>
                        {lineupsAtRisk} lineup entries already set for those
                        games will be deleted with them.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {stale ? (
              <RedateDraftButton
                seasonId={seasonId}
                targetLabel={stale.shiftedLabel}
              />
            ) : null}
            <form action={action}>
              <input type="hidden" name="season_id" value={seasonId} />
              {/*
                ⛔ The acknowledgement names the night: `publishSchedule` refuses unless it matches, so an
                out-of-date tab is refused rather than waved through.
              */}
              {stale ? (
                <input type="hidden" name="stale_ok" value={stale.firstNight} />
              ) : null}
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending
                  ? destructive
                    ? "Replacing…"
                    : "Publishing…"
                  : // ⚠️ "…anyway" carries the warning onto the button: a replace and a stale publish
                    // share this button, and only the label tells them apart.
                    `${destructive ? "Replace" : "Publish"}${stale ? " anyway" : ""}`}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { publishSchedule, type PublishState } from "@/lib/actions/schedule";
import { RedateDraftButton } from "@/components/manage/redate-draft-button";
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
 * What the panel knows about a draft whose first game night has already passed.
 * Dates arrive formatted — this component renders them and does no date work of
 * its own, the same division `liveRange` already follows.
 */
export type StalePublish = {
  /** The raw "YYYY-MM-DD" first night, submitted back as the acknowledgement. */
  firstNight: string;
  /** That night, formatted for the manager. */
  firstNightLabel: string;
  /** How many of the draft's nights are already behind us. */
  passedNights: number;
  /** Where the first night lands if the draft is moved forward. */
  shiftedLabel: string;
};

/**
 * Publish, or replace.
 *
 * Two things here confirm rather than one, and for different reasons:
 *
 *  - a **replace** destroys a live schedule, so it always has;
 *  - a **stale draft** — one whose first game night has already passed — does
 *    not destroy anything, and is worse. Publishing it starts the season in the
 *    past, which trips `season_is_started` the moment it lands: generate,
 *    replace and remove all refuse from then on, permanently, with no undo. A
 *    season's first publish is otherwise one click, and stays one click when the
 *    draft's dates are still ahead.
 *
 * ⚠️ THE STALE CASE IS CONFIRMED, NOT REFUSED, and that is a decision. A
 * manager whose games really were played on Tuesday and who is publishing on
 * Thursday before entering the scores needs this to go through. What they must
 * not be able to do is publish it without being told — so the dialog says what
 * it costs and offers the way out (move the draft forward) beside the way on.
 *
 * The panel does not render this at all on a started season; see the mode gate
 * in schedule-builder-panel.tsx.
 */
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
  /**
   * The live schedule's date range, already formatted by the server panel with
   * `formatLongDate` — the same wording the rest of the panel uses. Null when
   * no live game carries a date.
   */
  liveRange: string | null;
  lineupsAtRisk: number;
  /** True in "replace" mode — a live schedule would be deleted. */
  destructive: boolean;
  /** Null when the draft's first game night is today or later. */
  stale: StalePublish | null;
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
  // `key` on the call site in schedule-builder-panel.tsx, or reintroduce an
  // explicit reset, if that assumption ever stops holding.
  //
  // ⚠️ The key also carries the stale night for the same reason: moving the
  // draft forward leaves this component mounted with the dialog open and its
  // warning no longer true. Remounting closes it, and the manager sees the
  // section as it now stands.
  const dialogOpen = open && !state?.ok;

  const range = liveRange ? ` (${liveRange})` : "";
  const confirms = destructive || !!stale;

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
                      {stale.firstNightLabel}) has already passed
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
                ⛔ THE ACKNOWLEDGEMENT, AND IT NAMES THE NIGHT. `publishSchedule`
                refuses a stale draft unless this matches the first night it
                finds, so a tab whose warning has gone out of date — another tab
                regenerated or moved the draft — is refused rather than waved
                through on a click aimed at different dates.
              */}
              {stale ? (
                <input type="hidden" name="stale_ok" value={stale.firstNight} />
              ) : null}
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending
                  ? destructive
                    ? "Replacing…"
                    : "Publishing…"
                  : // ⚠️ "…anyway" is the whole warning, carried onto the button
                    // itself: a manager who opened this dialog for the ordinary
                    // reason (a replace) and one who opened it because their
                    // draft has gone stale are about to click the same button in
                    // the same place, and only the label distinguishes them.
                    `${destructive ? "Replace" : "Publish"}${stale ? " anyway" : ""}`}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

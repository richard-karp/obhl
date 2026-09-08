"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import {
  redateDraftSchedule,
  type RedateDraftState,
} from "@/lib/actions/schedule";
import { RedateForm } from "@/components/manage/redate-draft-button";

/**
 * The formatted facts about a stale draft. The panel does the date work; both
 * this banner and the publish dialog render the same object.
 */
export type StaleNotice = {
  /** The raw "YYYY-MM-DD" first night, submitted back as the acknowledgement. */
  firstNight: string;
  /** That night, formatted for the manager. */
  firstNightLabel: string;
  /** How many of the draft's nights have already begun. */
  passedNights: number;
  /** Whole weeks the move would cover. */
  weeks: number;
  /** Where the first night lands if the draft is moved forward. */
  shiftedLabel: string;
};

/**
 * The warning a manager sees when their draft's first game has already been
 * played over, and the one-click way out of it.
 *
 * ⛔ MOUNTED WHETHER OR NOT THERE IS ANYTHING TO WARN ABOUT, AND THAT IS WHY IT
 * OWNS THE BANNER RATHER THAN SITTING INSIDE ONE. A successful move takes the
 * draft out of the stale state, so a component rendered only while stale
 * unmounts in the same commit its result arrives in — and the `useEffect` that
 * toasts never runs. That is not a theory: `28-schedule-form-state.spec.ts`
 * records the same race for PublishControls' success toast, which "often never
 * renders at all", and the first end-to-end run of this feature reproduced it.
 * Keeping this mounted and returning `null` when there is nothing to say is
 * what makes the confirmation reliable.
 *
 * ⚠️ So do not wrap this in `{stale ? … : null}` at the call site. The panel
 * decides whether the season is one that can act (it is not rendered on a
 * locked season, where neither publishing nor moving is possible), and `stale`
 * itself must reach this component as a prop, including when it is null.
 */
export function StaleDraftNotice({
  seasonId,
  stale,
}: {
  seasonId: string;
  stale: StaleNotice | null;
}) {
  const [state, action, pending] = useActionState<RedateDraftState, FormData>(
    redateDraftSchedule,
    null,
  );

  useEffect(() => {
    if (!state) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
  }, [state]);

  if (!stale) return null;

  return (
    <div className="border-destructive/40 bg-destructive/10 text-destructive space-y-2 rounded-lg border px-3 py-2 text-sm">
      <p>
        ⚠ This draft&apos;s first game night ({stale.firstNightLabel}) has
        already been played over
        {stale.passedNights > 1
          ? `, along with ${stale.passedNights - 1} more`
          : ""}
        . Publishing it now starts the season in the past, which locks it
        immediately — no regenerate, no replace, no remove, and no undo.
      </p>
      <p>
        Moving it forward{" "}
        {stale.weeks === 1 ? "a week" : `${stale.weeks} weeks`} keeps every
        matchup, game night and ice time exactly as they are below. Two things
        it can&apos;t carry with it: the weeks off and holidays you entered when
        generating aren&apos;t stored anywhere, so a moved night can land on one
        — and any saved requests that name a date (a bye on the 12th, an ice
        time on the 19th) will point at nights the draft no longer has.
      </p>
      <RedateForm
        seasonId={seasonId}
        targetLabel={stale.shiftedLabel}
        action={action}
        pending={pending}
      />
    </div>
  );
}

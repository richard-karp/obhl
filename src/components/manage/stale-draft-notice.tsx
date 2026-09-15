"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import {
  redateDraftSchedule,
  type RedateDraftState,
} from "@/lib/actions/schedule";
import { RedateForm } from "@/components/manage/redate-draft-button";

/** The formatted facts about a stale draft; the banner and the publish dialog render the same object. */
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

// ⛔ Mounted whether or not stale, returning null: rendered only while stale, a successful move unmounts it
// before its toast runs. ⚠️ So never wrap it in `{stale ? … : null}` at the call site.
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

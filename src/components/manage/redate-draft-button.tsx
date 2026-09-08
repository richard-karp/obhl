"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import {
  redateDraftSchedule,
  type RedateDraftState,
} from "@/lib/actions/schedule";
import { Button } from "@/components/ui/button";

/**
 * Move a stale draft forward a whole number of weeks — one click, and the only
 * action the builder offers that changes a draft's dates without regenerating
 * it.
 *
 * ⚠️ THE LABEL NAMES THE DESTINATION, NOT THE OPERATION. "Re-date draft" says
 * nothing a manager can check; "Move draft to Tue 15 Sep" is a claim they can
 * disagree with before they click it, which is the whole reason the date is
 * computed on the server and passed in rather than described in the abstract.
 *
 * ⚠️ THE DIALOG'S COPY OF THE BUTTON. The banner's copy lives in
 * `StaleDraftNotice`, which owns its own action state so that its confirmation
 * toast survives the move; this one is inside a dialog that closes on success —
 * PublishControls is keyed on the stale night and remounts — so its success
 * message races that unmount and is usually lost. That is acceptable here and
 * only here: the outcome is unmistakable on the page behind it (the warning is
 * gone and every date in the night list has moved), and a FAILURE keeps the
 * dialog open, which is the case that needs words.
 *
 * Deliberately not styled as a primary button. Publishing is still what the
 * manager came to do; this is the way out of a schedule that went stale
 * underneath them.
 */
export function RedateDraftButton({
  seasonId,
  targetLabel,
}: {
  seasonId: string;
  /** Where the first night lands, already formatted by the server panel. */
  targetLabel: string;
}) {
  const [state, action, pending] = useActionState<RedateDraftState, FormData>(
    redateDraftSchedule,
    null,
  );

  // Toasting is a side effect on an external system (sonner), so it belongs in
  // an effect — the same shape as PublishControls and RemoveControls. Nothing
  // else needs saying afterwards: the action revalidates, so a success re-renders
  // this whole section with the new dates and without the warning.
  useEffect(() => {
    if (!state) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
  }, [state]);

  return (
    <form action={action}>
      <input type="hidden" name="season_id" value={seasonId} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Moving…" : `Move draft to ${targetLabel}`}
      </Button>
    </form>
  );
}

"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import {
  redateDraftSchedule,
  type RedateDraftState,
} from "@/lib/actions/schedule";
import { Button } from "@/components/ui/button";

/**
 * The form itself, with no state of its own.
 *
 * ⚠️ SEPARATE FROM THE STATE ON PURPOSE. Two places offer this move — the
 * warning banner and the publish confirmation — and they need *different*
 * action states, because one survives a successful move and the other does not
 * (see `StaleDraftNotice`). What they must not have is two copies of the
 * markup: the label is the claim a manager checks before clicking, and a second
 * copy is a second thing to forget to change.
 */
export function RedateForm({
  seasonId,
  targetLabel,
  action,
  pending,
}: {
  seasonId: string;
  /** Where the first night lands, already formatted by the server panel. */
  targetLabel: string;
  action: (payload: FormData) => void;
  pending: boolean;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="season_id" value={seasonId} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Moving…" : `Move draft to ${targetLabel}`}
      </Button>
    </form>
  );
}

/**
 * Move a stale draft forward a whole number of weeks — the publish dialog's
 * copy of the button.
 *
 * ⚠️ THE LABEL NAMES THE DESTINATION, NOT THE OPERATION. "Re-date draft" says
 * nothing a manager can check; "Move draft to September 15, 2026" is a claim
 * they can disagree with before they click it, which is why the date is
 * computed on the server and passed in rather than described in the abstract.
 *
 * ⚠️ ITS SUCCESS MESSAGE IS EXPECTED TO BE LOST, which is why the banner keeps
 * its own. This sits inside a dialog whose branch disappears once the draft
 * stops being stale, so the effect below races that unmount — the same race
 * `28-schedule-form-state.spec.ts` records for the publish toast. Acceptable
 * here and only here: the outcome is unmistakable on the page behind it (the
 * warning is gone and every date in the night list has moved), and a FAILURE
 * keeps the dialog open, which is the case that needs words.
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
  targetLabel: string;
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

  return (
    <RedateForm
      seasonId={seasonId}
      targetLabel={targetLabel}
      action={action}
      pending={pending}
    />
  );
}

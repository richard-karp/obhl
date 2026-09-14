"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import {
  redateDraftSchedule,
  type RedateDraftState,
} from "@/lib/actions/schedule";
import { Button } from "@/components/ui/button";

// ⚠️ Stateless on purpose: the banner and the publish dialog need different action states (one survives a
// successful move), but must share one copy of this markup and its label.
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

// ⚠️ The label names the destination, computed server-side, so a manager can check it. ⚠️ Its success toast
// races the dialog's unmount and is expected to be lost; the banner keeps its own, and a failure stays open.
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

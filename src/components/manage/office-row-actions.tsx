"use client";

import { removeDeputy } from "@/lib/actions/office";
import { Button } from "@/components/ui/button";

export function OfficeRowActions({
  id,
  tier,
  viewerIsCommissioner,
}: {
  id: string;
  /** The tier this row holds — what may be done to it, not who is looking. */
  tier: "commissioner" | "deputy";
  /**
   * Whether the viewer may change anything here at all. A deputy sees the same
   * roster and no controls: they are not above their peers, and they are not
   * above the tier itself.
   */
  viewerIsCommissioner: boolean;
}) {
  // No control for a commissioner, for ANYONE — including another commissioner.
  // The tier is peer-flat, so nobody outranks it, and an absent control with no
  // explanation reads as a bug rather than a rule. The page says why at length;
  // this is the short form on the row itself.
  if (tier === "commissioner") {
    return (
      <span
        className="text-muted-foreground text-xs"
        title="The commissioner tier is peer-flat — no commissioner outranks another — so it cannot be changed from this page by anyone. Appointing or removing a commissioner is done directly in the database."
      >
        Changed in the database
      </span>
    );
  }

  if (!viewerIsCommissioner) {
    return (
      <span
        className="text-muted-foreground text-xs"
        title="Deputies can see the office roster but not change it. Only a commissioner appoints or removes a deputy."
      >
        View only
      </span>
    );
  }

  return (
    <form action={removeDeputy}>
      <input type="hidden" name="id" value={id} />
      {/* Removes the tier only. Their account, their role and every league
          membership they had before the appointment are untouched. */}
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className="text-destructive"
        title="Remove the deputy tier"
      >
        Remove
      </Button>
    </form>
  );
}

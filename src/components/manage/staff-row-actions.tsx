"use client";

import { updateStaffRole, removeStaff } from "@/lib/actions/people";
import { Button } from "@/components/ui/button";

export function StaffRowActions({
  id,
  role,
  leagueId,
  canRemove,
}: {
  id: string;
  role: string;
  /** Both actions are scoped to this league; the server checks it, not trusts it. */
  leagueId: string;
  /**
   * Whether Remove would actually be honoured. The server refuses silently —
   * a form action returning void has nowhere to put a message — so the page
   * works out the answer and this renders the reason instead of a button that
   * appears to do nothing.
   */
  canRemove: boolean;
}) {
  const remove = canRemove ? (
    <form action={removeStaff}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="league_id" value={leagueId} />
      {/* Removes them from this league — it does not delete the account. */}
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className="text-destructive"
        title="Remove from this league"
      >
        Remove
      </Button>
    </form>
  ) : null;

  // A manager's ROLE is not editable here. Every manager can open this page, so
  // offering it would let any manager unmake any other. Removing them from the
  // league is a different question, and is offered — that is how a second
  // manager account gets taken back.
  if (role === "league_manager") {
    return (
      <div className="flex items-center justify-end gap-2">
        <span className="text-muted-foreground text-xs">
          Role changed by hand
        </span>
        {remove}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <form action={updateStaffRole}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="league_id" value={leagueId} />
        <select
          name="role"
          aria-label="Change role"
          defaultValue={role}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
        >
          <option value="league_manager">Manager</option>
          <option value="scorekeeper">Scorekeeper</option>
          <option value="captain">Captain</option>
        </select>
      </form>
      {remove}
    </div>
  );
}

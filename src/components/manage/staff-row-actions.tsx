"use client";

import { updateStaffRole, removeStaff } from "@/lib/actions/people";
import { Button } from "@/components/ui/button";

export function StaffRowActions({
  id,
  role,
  leagueId,
  canRemove,
  canChangeRole,
  officeTier,
}: {
  id: string;
  role: string;
  /** Both actions are scoped to this league; the server checks it, not trusts it. */
  leagueId: string;
  /** Whether Remove would be honoured: the server refuses silently (a void form action), so the page decides. */
  canRemove: boolean;
  // Whether any role change would be honoured: a role reaches every league the person is in, and
  // `updateStaffRole` silently refuses a change reaching one the viewer is not in.
  canChangeRole: boolean;
  /** The League Office tier, or null. An office row is read-only here: its tier is managed in League Office. */
  officeTier: "commissioner" | "deputy" | null;
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

  // The office first: an office member is a `league_manager` too, and would be offered a Remove that
  // `removeStaff` refuses. Their membership is a rule, not a row.
  if (officeTier) {
    return (
      <div className="flex items-center justify-end gap-2">
        <span
          className="text-muted-foreground text-xs"
          title="This account holds a League Office tier, which reaches every league. Both the tier and this person's role are managed in League Office."
        >
          Managed in League Office
        </span>
      </div>
    );
  }

  // ⛔ One condition, the server's: `canChangeRole` knows a peer can't unmake a manager but the office can.
  // Testing `role === "league_manager"` first hid a change the server permitted. Only the reason branches.
  if (!canChangeRole) {
    const managerPeer = role === "league_manager";
    return (
      <div className="flex items-center justify-end gap-2">
        <span
          className="text-muted-foreground text-xs"
          title={
            managerPeer
              ? "A manager's role cannot be changed by another manager. Promoting someone TO manager still works, and removing them from this league is offered separately; unmaking a manager takes a commissioner."
              : "A role applies in every league, and this person also works one you are not in. Changing it needs a manager of every league they work — if nobody is in all of them, a commissioner changes it."
          }
        >
          {managerPeer
            ? "Role changed by a commissioner"
            : "Also works another league"}
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

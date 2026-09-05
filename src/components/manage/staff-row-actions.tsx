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
  /**
   * Whether Remove would actually be honoured. The server refuses silently —
   * a form action returning void has nowhere to put a message — so the page
   * works out the answer and this renders the reason instead of a button that
   * appears to do nothing.
   */
  canRemove: boolean;
  /**
   * Whether ANY role change on this row would be honoured. A role is
   * instance-wide, so it lands in every league this person belongs to — and
   * `updateStaffRole` refuses every change that would reach a league the viewer
   * is not in, not only a promotion to manager. Refused silently, like Remove,
   * so the control is replaced by the reason rather than offered and ignored.
   */
  canChangeRole: boolean;
  /**
   * The League Office tier this person holds, or null. An office row is
   * read-only here for everyone — the tier is managed in League Office, and a
   * row offering to change a deputy's underlying role while their tier lives on
   * another page invites the wrong mental model of what the row controls.
   */
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

  // The office first, because an office member is a `league_manager` too and
  // would otherwise fall into the branch below and be offered a Remove that
  // `removeStaff` refuses. Their membership is a rule rather than a row, so
  // there is nothing here to revoke.
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

  // ⛔ ONE condition decides whether the control renders, and it is the same one
  // the server applies. A manager's role is not editable by a PEER — every
  // manager can open this page, so offering it would let any manager unmake any
  // other — but the League Office outranks them, and `canChangeRole` already
  // knows both facts.
  //
  // Testing `role === "league_manager"` ahead of it is what made a commissioner's
  // row render nothing while `updateStaffRole` was willing to act: the page
  // refused what the server permitted, which is the disagreement this component
  // exists to prevent.
  //
  // Only the REASON differs, so only the reason branches. Remove is offered in
  // both: revoking this league is a different question from changing a role.
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

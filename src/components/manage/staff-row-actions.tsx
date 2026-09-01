"use client";

import { updateStaffRole, removeStaff } from "@/lib/actions/people";
import { Button } from "@/components/ui/button";

export function StaffRowActions({ id, role }: { id: string; role: string }) {
  // No controls for a manager row. Every manager can open this page, so
  // offering them would mean any manager could demote or delete any other —
  // and Remove deletes the account outright. The server refuses this too;
  // this is what stops the page presenting it as available.
  if (role === "league_manager") {
    return (
      <p className="text-muted-foreground text-right text-xs">
        Managers are changed by hand
      </p>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <form action={updateStaffRole}>
        <input type="hidden" name="id" value={id} />
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
      <form action={removeStaff}>
        <input type="hidden" name="id" value={id} />
        <Button type="submit" variant="ghost" size="sm" className="text-destructive">
          Remove
        </Button>
      </form>
    </div>
  );
}

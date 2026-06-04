"use client";

import { updateStaffRole, removeStaff } from "@/lib/actions/people";
import { Button } from "@/components/ui/button";

export function StaffRowActions({ id, role }: { id: string; role: string }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <form action={updateStaffRole}>
        <input type="hidden" name="id" value={id} />
        <select
          name="role"
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

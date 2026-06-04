"use client";

import { useActionState, useState } from "react";
import {
  createStaffAccount,
  type PeopleActionState,
} from "@/lib/actions/people";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type CaptainOption = { id: string; label: string };

export function CreateStaffForm({ captains }: { captains: CaptainOption[] }) {
  const [state, action, pending] = useActionState<PeopleActionState, FormData>(
    createStaffAccount,
    null,
  );
  const [role, setRole] = useState("scorekeeper");

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required placeholder="person@example.com" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="display_name">Display name</Label>
        <Input id="display_name" name="display_name" placeholder="Optional" />
      </div>
      <div className="space-y-2">
        <Label>Role</Label>
        {/* Hidden field carries the value since Radix Select isn't a native input */}
        <input type="hidden" name="role" value={role} />
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="league_manager">League manager</SelectItem>
            <SelectItem value="scorekeeper">Scorekeeper</SelectItem>
            <SelectItem value="captain">Captain</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {role === "captain" ? (
        <div className="space-y-2">
          <Label>Linked player (captain)</Label>
          <select
            name="player_id"
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            defaultValue=""
          >
            <option value="" disabled>
              Choose a captain…
            </option>
            {captains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="flex items-end gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add staff account"}
        </Button>
        {state ? (
          <p
            className={
              state.ok
                ? "text-sm text-emerald-600 dark:text-emerald-400"
                : "text-destructive text-sm"
            }
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

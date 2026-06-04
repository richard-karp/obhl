"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createSeason, type SeasonActionState } from "@/lib/actions/seasons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateSeasonForm() {
  const router = useRouter();
  const [state, action, pending] = useActionState<SeasonActionState, FormData>(
    createSeason,
    null,
  );

  // On success, continue to the new season's setup (add teams next).
  useEffect(() => {
    if (state?.ok && state.seasonId) router.push(`/seasons/${state.seasonId}`);
  }, [state, router]);

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-3">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" placeholder="Fall 2026" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="starts_on">Starts</Label>
        <Input id="starts_on" name="starts_on" type="date" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="ends_on">Ends</Label>
        <Input id="ends_on" name="ends_on" type="date" />
      </div>
      <div className="flex items-center gap-3 sm:col-span-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create season"}
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

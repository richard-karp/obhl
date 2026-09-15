"use client";

import { useActionState } from "react";
import { setStaffPassword, type SetPasswordState } from "@/lib/actions/office";
import { MIN_PASSWORD } from "@/lib/auth/password";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ⚠️ A convenience, not a restriction: `setStaffPassword` checks `requireCommissioner` and the target's tier.
// A typed address, not a picker (lookups scale with the instance); the result is always reported.
export function OfficePasswordForm() {
  const [state, action, pending] = useActionState<SetPasswordState, FormData>(
    setStaffPassword,
    null,
  );

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="office-pw-email">Staff email</Label>
          <Input
            id="office-pw-email"
            name="email"
            type="email"
            autoComplete="off"
            placeholder="person@example.com"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="office-pw-value">New password</Label>
          <Input
            id="office-pw-value"
            name="password"
            type="password"
            // Never the browser's saved password for THIS session's account —
            // the field is for somebody else's login.
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            required
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Setting…" : "Set password"}
        </Button>
        <p className="text-muted-foreground text-xs">
          At least {MIN_PASSWORD} characters. Give it to them out of band — it
          is not shown again.
        </p>
      </div>
      {state ? (
        <p
          role="status"
          aria-live="polite"
          className={
            state.ok
              ? "text-sm text-emerald-600 dark:text-emerald-400"
              : "text-destructive text-sm"
          }
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

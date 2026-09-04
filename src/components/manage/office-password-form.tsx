"use client";

import { useActionState } from "react";
import { setStaffPassword, type SetPasswordState } from "@/lib/actions/office";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Set a staff account's password, as a commissioner.
 *
 * ⚠️ This form is a convenience, not a restriction. `setStaffPassword` calls
 * `requireCommissioner` itself and checks the target's tier itself; drawing the
 * card only for a commissioner decides what is OFFERED and nothing else.
 *
 * Typed address rather than a picker on purpose. The office page already pays one
 * admin-API request per manager to label its appoint dropdown, and that cost
 * scales with the instance; a list of every staff account — managers,
 * scorekeepers and captains across every league — would scale worse for a control
 * whose whole use is "this specific person cannot get in". The action resolves
 * the address and says plainly when nothing answers to it.
 *
 * The result is reported, unlike the appoint/remove actions on this page, which
 * refuse quietly because the page renders a reason wherever they would. There is
 * no such reason to render here: whether an address matches an account is not
 * knowable until it is submitted, and a password that silently did not get set is
 * the worst possible outcome for a recovery path.
 */
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
            minLength={8}
            required
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Setting…" : "Set password"}
        </Button>
        <p className="text-muted-foreground text-xs">
          At least 8 characters. Give it to them out of band — it is not shown
          again.
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

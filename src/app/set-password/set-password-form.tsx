"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  sendPasswordReset,
  updateOwnPassword,
  type AuthActionState,
} from "@/lib/actions/auth";
import { MIN_PASSWORD } from "@/lib/auth/password";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ⚠️ `minLength` is a courtesy; `updateOwnPassword` enforces the floor. Both read `MIN_PASSWORD`, or
// the form refuses what it invited. The result is reported: a silent failure leaves no way back in.
export function SetPasswordForm() {
  const [state, action, pending] = useActionState<AuthActionState, FormData>(
    updateOwnPassword,
    null,
  );

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD}
          required
        />
        <p className="text-muted-foreground text-xs">
          At least {MIN_PASSWORD} characters.
        </p>
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Saving…" : "Set password"}
      </Button>
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
      {state?.ok ? (
        <p className="text-center text-sm">
          <Link href="/" className="hover:underline">
            Continue to your leagues →
          </Link>
        </p>
      ) : null}
    </form>
  );
}

// ⛔ A sessionless visit (a bookmark, an expired link) gets this form, not an error page: it is the
// recovery. A plain server action, so it submits before hydration.
export function RequestResetForm() {
  const [state, action, pending] = useActionState<AuthActionState, FormData>(
    sendPasswordReset,
    null,
  );

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="reset-email">Email</Label>
        <Input
          id="reset-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Sending…" : "Email me a link"}
      </Button>
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

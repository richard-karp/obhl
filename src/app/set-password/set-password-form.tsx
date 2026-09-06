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

/**
 * Set your own password, on the session the emailed link just established.
 *
 * Modelled on `components/manage/office-password-form.tsx` — the same single
 * `type="password"` field, the same reported result rather than a quiet refusal,
 * and for the sharper version of the same reason: a password that silently did
 * not get set leaves someone believing they have a way back in.
 *
 * ⚠️ `minLength` here is a courtesy, not the rule. `updateOwnPassword` checks the
 * floor itself, because a form control is not a check. Both read the SAME
 * number: a hint that says 8 while the action enforces 10 is a form that
 * refuses what it invited.
 */
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

/**
 * Ask for the link that gets you here.
 *
 * ⛔ THIS IS WHY A SESSIONLESS VISIT IS NOT AN ERROR PAGE. Someone who lands
 * here without a link — a bookmark, an expired link, a second click on a used
 * one — wants exactly one thing, and refusing them with a sentence and a way
 * back to /login makes them hunt for it. The request form IS the recovery.
 *
 * A plain server action, like the magic-link form: it submits before hydration,
 * which is the state a password path most has to survive.
 */
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

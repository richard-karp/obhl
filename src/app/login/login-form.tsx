"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  sendMagicLink,
  signInWithPassword,
  type AuthActionState,
} from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The magic link, still the primary way in.
 *
 * ⚠️ LEFT ALONE ON PURPOSE when the password block below was added. This form
 * posts straight to a server action, so it submits with no JavaScript at all —
 * the one path that has to keep working when everything else does not. Most
 * staff accounts still have no password.
 */
export function LoginForm() {
  const [state, action, pending] = useActionState<AuthActionState, FormData>(
    sendMagicLink,
    null,
  );

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Sending…" : "Send magic link"}
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

/**
 * Sign in with a password.
 *
 * ⚠️ SECONDARY, BY CONSTRUCTION. It sits below the magic link and is drawn as
 * the fallback, because until people have used the reset flow, almost no staff
 * account has a password. Neither path may become the only one: a single way in
 * is what the whole password effort exists to remove.
 *
 * ⛔ ONE SERVER ACTION, NOT A CLIENT DISPATCHER. An earlier version put both
 * this and the reset trigger in one form and chose between them in a client
 * function, to avoid asking for the address twice. It works — once hydrated. A
 * click BEFORE hydration submits the form natively, and a form whose action is a
 * client function has no endpoint to post to, so the browser reloads /login with
 * the fields cleared and nothing said. Measured: a Playwright click straight
 * after `goto` reproduced it every time, and the same click after
 * `networkidle` signed in fine. Server actions survive that window, so the way
 * to GET a password is a link to `/set-password` instead of a second button
 * here.
 */
export function PasswordSignInForm() {
  const [state, action, pending] = useActionState<AuthActionState, FormData>(
    signInWithPassword,
    null,
  );

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="password-email">Email</Label>
        <Input
          id="password-email"
          name="email"
          type="email"
          autoComplete="username"
          placeholder="you@example.com"
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <Button
        type="submit"
        variant="secondary"
        className="w-full"
        disabled={pending}
      >
        {pending ? "Signing in…" : "Sign in with password"}
      </Button>
      {state ? (
        <p
          role="status"
          aria-live="polite"
          className="text-destructive text-sm"
        >
          {state.message}
        </p>
      ) : null}
      <p className="text-muted-foreground text-center text-xs">
        <Link href="/set-password" className="hover:underline">
          Set or reset your password
        </Link>
      </p>
    </form>
  );
}

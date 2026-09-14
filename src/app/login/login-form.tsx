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

// ⚠️ The magic link stays the primary way in: a server action, it submits with no JavaScript, and most
// staff accounts have no password. Neither sign-in path may become the only one.
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

// ⛔ One server action, not a client dispatcher: a click before hydration posts natively, and a client
// function has no endpoint, so /login reloads blank. Getting a password is a link to `/set-password`.
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

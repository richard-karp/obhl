/**
 * Whether the one-click dev sign-in panel is available.
 *
 * Always on in local development. In a deployed (NODE_ENV=production) build it's
 * on ONLY when `ENABLE_DEV_LOGIN=true` — an explicit opt-in for test/staging
 * deploys so testers can jump into the staff tools without email sign-in.
 *
 * ⚠️ While this is on, anyone with the URL can act as any role. Remove the
 * ENABLE_DEV_LOGIN env var (or set it to anything but "true") for real production.
 */
export function devLoginEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.ENABLE_DEV_LOGIN === "true"
  );
}

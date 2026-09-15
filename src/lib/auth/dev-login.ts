/**
 * ⚠️ While on, anyone with the URL can sign in as any role: off in a production build
 * unless `ENABLE_DEV_LOGIN=true` (`RUNBOOK.md` → `ENABLE_DEV_LOGIN`).
 */
export function devLoginEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.ENABLE_DEV_LOGIN === "true"
  );
}

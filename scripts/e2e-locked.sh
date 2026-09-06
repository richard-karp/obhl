#!/bin/bash
# Run Playwright while holding the shared-database lock.
#
#   scripts/e2e-locked.sh e2e/27-schedule-repair.spec.ts
#   PORT=3101 scripts/e2e-locked.sh          # whole suite, explicit port
#
# ⚠️ WHY THIS EXISTS. Parallel worktrees each get their own dev server (see the
# PORT note in playwright.config.ts) but they all share ONE local Supabase, and
# `e2e/global-setup.ts` resets it on every run. Two runs overlapping means one
# wipes the other's fixture mid-test — which surfaces as "could not read
# leagues", a half-seeded auth table, or an app that simply looks broken, never
# as a collision. It killed three runs on 2026-09-06 before anyone noticed why.
#
# The lock is a directory because `mkdir` is atomic on every filesystem we run
# on; the trap releases it however the script exits, including Ctrl-C.
set -u
LOCK=/tmp/obhl-e2e.lock
until mkdir "$LOCK" 2>/dev/null; do
  echo "waiting for the shared e2e database lock..."
  sleep 20
done
trap 'rmdir "$LOCK"' EXIT
echo "e2e lock taken"

# PORT is the worktree's own; playwright.config.ts derives both the baseURL and
# the dev-server port from it, and `reuseExistingServer` will otherwise hand this
# run another branch's server and report its failures as yours.
export PORT="${PORT:-3000}"
export NEXT_PUBLIC_SITE_URL="${NEXT_PUBLIC_SITE_URL:-http://localhost:$PORT}"
npx playwright test "$@"

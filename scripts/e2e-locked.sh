#!/bin/bash
# Run Playwright while holding the shared-database lock.
#
#   scripts/e2e-locked.sh e2e/29-schedule-repair.spec.ts
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

# ⛔ STALENESS, OR ONE SIGKILL LOCKS EVERY FUTURE RUN FOREVER. The trap does not
# run for SIGKILL, a crashed shell or a rebooted machine, so the holder's PID
# goes in the lock and a lock whose holder is gone is broken rather than waited
# on. Racy in principle — two waiters could break the same dead lock — and that
# is fine: the loser simply loops and takes it on the next pass.
while ! mkdir "$LOCK" 2>/dev/null; do
  holder=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    echo "e2e lock held by dead pid $holder — breaking it"
    rm -rf "$LOCK"
    continue
  fi
  echo "waiting for the shared e2e database lock (held by pid ${holder:-unknown})..."
  sleep 20
done
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT
echo "e2e lock taken by pid $$"

# PORT is the worktree's own; playwright.config.ts derives both the baseURL and
# the dev-server port from it, and `reuseExistingServer` will otherwise hand this
# run another branch's server and report its failures as yours.
export PORT="${PORT:-3000}"
export NEXT_PUBLIC_SITE_URL="${NEXT_PUBLIC_SITE_URL:-http://localhost:$PORT}"
npx playwright test "$@"

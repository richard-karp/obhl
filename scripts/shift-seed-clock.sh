#!/bin/bash
# Move the seeded fixture N whole weeks into the future, in place.
#
#   scripts/shift-seed-clock.sh 3     # the fixture as it will be seeded in 3 weeks
#   scripts/shift-seed-clock.sh 0     # back to normal
#
# ⚠️ WHY THIS EXISTS. `supabase/seed.sql` builds every date from `current_date`,
# so the fixture's calendar position — which month a night falls in, whether a
# game night sits near a month boundary, which side of a DST change it lands on
# — changes with the real date and with nothing a test can control. That is a
# whole class of latent failure: `c7ec42d` on this branch fixed a date-picker
# click that would have started failing on 2026-09-28 and on 105 of the
# following 800 days, and it passed a full green suite while latent because
# today's clock did not trigger it. This script is how CI reaches those dates
# early. See `.github/workflows/clock-shifted.yml`.
#
# ⛔ THE SUBSTITUTION IS NOT THE WHOLE STORY, AND THE PART IT LEAVES OUT IS THE
# PART THAT BITES. This moves the fixture. It does NOT move `now()`, which is
# what `season_is_started` and every `scheduled_at < now()` comparison read, and
# a fixture that overshoots the clock fails specs for reasons that have nothing
# to do with the defect being hunted (a session lost an afternoon to exactly
# that on 2026-09-07, substituting a date nine months out). The 0..11 ceiling
# below is the window inside which the fixture and the clock still agree; the
# reasoning is written out at the knob in `supabase/seed.sql`, and
# `scripts/check-fixture-clock.mjs` re-proves it against the database rather
# than trusting either comment.
set -euo pipefail

SEED="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/supabase/seed.sql"
WEEKS="${1-}"

if [ -z "$WEEKS" ]; then
  echo "usage: scripts/shift-seed-clock.sh <weeks 0-11>" >&2
  exit 2
fi

case "$WEEKS" in
  ''|*[!0-9]*) echo "shift-seed-clock: '$WEEKS' is not a whole number of weeks" >&2; exit 2 ;;
esac

if [ "$WEEKS" -gt 11 ]; then
  echo "shift-seed-clock: $WEEKS weeks is past the 11-week ceiling." >&2
  echo "  Beyond it the Spring seasons stop reading as started and the fixture" >&2
  echo "  disagrees with the clock that judges it. See the knob comment in" >&2
  echo "  supabase/seed.sql for the arithmetic." >&2
  exit 2
fi

# ⛔ THE REWRITE IS CHECKED, NOT ASSUMED. A regex that silently matches nothing
# leaves the seed at 0 and hands CI a GREEN RUN THAT PROVED NOTHING — the worst
# outcome available here, strictly worse than a red one. So: fail if the knob
# is not found, and fail if the file did not actually change.
if ! grep -qE '^  v_shift_weeks int := [0-9]+;$' "$SEED"; then
  echo "shift-seed-clock: no 'v_shift_weeks int := N;' line in $SEED" >&2
  echo "  Someone renamed or removed the knob. Fix this script rather than" >&2
  echo "  letting the job run unshifted." >&2
  exit 1
fi

before="$(sed -nE 's/^  v_shift_weeks int := ([0-9]+);$/\1/p' "$SEED")"
perl -pi -e "s/^  v_shift_weeks int := [0-9]+;\$/  v_shift_weeks int := $WEEKS;/" "$SEED"
after="$(sed -nE 's/^  v_shift_weeks int := ([0-9]+);$/\1/p' "$SEED")"

if [ "$after" != "$WEEKS" ]; then
  echo "shift-seed-clock: the rewrite did not take (v_shift_weeks is still $after)" >&2
  exit 1
fi

echo "shift-seed-clock: v_shift_weeks $before -> $after (fixture seeds $WEEKS week(s) ahead of today)"

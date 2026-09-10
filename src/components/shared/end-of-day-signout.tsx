"use client";

import { useEffect, useRef } from "react";
import { signOut } from "@/lib/actions/auth";
import { LEAGUE_TZ, leagueDayStart } from "@/lib/format";

/** The league-zone calendar date, computed in the browser. */
function leagueDateNow(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LEAGUE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Signs a scorekeeper out when their day ends.
 *
 * ⛔ A CLIENT COMPONENT BECAUSE IT HAS TO BE. Signing out writes cookies, and
 * Next refuses cookie writes during a Server Component render — so the page
 * cannot do this itself. The alternatives were middleware (this repo has none,
 * and adding one for a single rule is a large blast radius) or leaving the
 * session alive until the next sign-in. This is the smallest thing that works.
 *
 * Two triggers, because either alone leaves a real gap:
 *
 *  1. **On mount**, if the browser's league-date already differs from the one
 *     this page rendered for. Catches the laptop left closed overnight and woken
 *     the next morning — no timer survives that.
 *  2. **A timer to the next league midnight.** Catches the rink laptop left open
 *     and untouched, which is the case the whole rule exists for: a SHARED
 *     account on a machine anyone can walk up to.
 *
 * ⚠️ It computes the league date in the BROWSER's clock but the LEAGUE's zone,
 * so a scorekeeper travelling — or a laptop with the wrong timezone set — still
 * rolls over when the league does, not when their device thinks midnight is.
 *
 * ⚠️ Not a security boundary. Anyone can disable JavaScript. The boundary is the
 * page guard, which refuses a scorekeeper any game that is not today regardless.
 * This ends the SESSION so a shared credential is not left signed in overnight.
 */
export function EndOfDaySignOut({ renderedFor }: { renderedFor: string }) {
  const fired = useRef(false);

  useEffect(() => {
    const go = () => {
      if (fired.current) return;
      fired.current = true;
      void signOut();
    };

    // ⛔ STRICTLY AHEAD, NOT MERELY DIFFERENT. `!==` fires in both directions,
    // and a rink laptop whose clock reads YESTERDAY would then sign out on every
    // mount: sign in, land here, immediate sign-out, back to /login, forever —
    // no error, no message, for the account least able to diagnose it. A date
    // BEHIND the server's is a broken clock, not a finished night.
    // `YYYY-MM-DD` compares correctly as a string.
    if (leagueDateNow() > renderedFor) {
      go();
      return;
    }

    // ⛔ THE EXACT INSTANT, FROM `leagueDayStart` — NOT ARITHMETIC ON LOCAL
    // HOURS. An earlier version stepped an hour at a time until the league date
    // flipped and then rounded to :00, which is exact only where the browser's
    // UTC offset is a whole hour from the league's. On a half-hour offset
    // (Newfoundland, India) it fired up to 30 minutes late. `leagueDayStart`
    // already answers "when does this league day begin" as a UTC instant, and it
    // is the same function the server filters games with — so the browser and
    // the database agree on when the night ends by construction.
    const [y, m, d] = renderedFor.split("-").map(Number);
    const tomorrow = new Date(Date.UTC(y, m - 1, d));
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const target = new Date(
      leagueDayStart(tomorrow.toISOString().slice(0, 10)),
    ).getTime();

    // Clamp: `setTimeout` caps near 2^31 ms and a negative delay fires at once.
    // A league night is never near either, but a clock skewed by days should not
    // sign somebody out mid-game.
    const ms = Math.min(Math.max(target - Date.now(), 0), 2 ** 31 - 1);
    const timer = setTimeout(go, ms);
    return () => clearTimeout(timer);
  }, [renderedFor]);

  return null;
}

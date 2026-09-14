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

// ⛔ A client component: a Server Component render can't write cookies. It fires on mount if the league day has
// turned, or on a timer to league midnight. ⚠️ Not a security boundary: the page guard is.
export function EndOfDaySignOut({ renderedFor }: { renderedFor: string }) {
  const fired = useRef(false);

  useEffect(() => {
    const go = () => {
      if (fired.current) return;
      fired.current = true;
      void signOut();
    };

    // ⛔ Strictly ahead, not `!==`: a laptop clock reading yesterday would sign out on every mount, forever.
    // `YYYY-MM-DD` compares correctly as a string.
    if (leagueDateNow() > renderedFor) {
      go();
      return;
    }

    // ⛔ The exact instant from `leagueDayStart`, not hour arithmetic (late on half-hour offsets): the same function
    // the server filters games with, so browser and database agree on when the night ends.
    const [y, m, d] = renderedFor.split("-").map(Number);
    const tomorrow = new Date(Date.UTC(y, m - 1, d));
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const target = new Date(
      leagueDayStart(tomorrow.toISOString().slice(0, 10)),
    ).getTime();

    // Clamp: `setTimeout` caps near 2^31 ms, and a clock skewed by days must not sign someone out mid-game.
    const ms = Math.min(Math.max(target - Date.now(), 0), 2 ** 31 - 1);
    const timer = setTimeout(go, ms);
    return () => clearTimeout(timer);
  }, [renderedFor]);

  return null;
}

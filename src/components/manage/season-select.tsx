"use client";

import { useFormStatus } from "react-dom";
import { usePathname } from "next/navigation";
import { selectSeason } from "@/lib/actions/season-context";
import { cn } from "@/lib/utils";

export type SeasonOption = { id: string; name: string; isActive: boolean };

/**
 * The select itself, split out so `useFormStatus` has a form above it — the
 * hook reads the enclosing form's pending state and returns nothing at all
 * from the component that renders the form.
 */
function Select({
  seasons,
  currentId,
}: {
  seasons: SeasonOption[];
  currentId: string | null;
}) {
  const { pending } = useFormStatus();
  return (
    <>
      <label className="sr-only" htmlFor="season-switcher">
        Select season
      </label>
      <select
        id="season-switcher"
        name="season_id"
        defaultValue={currentId ?? ""}
        disabled={pending}
        aria-label="Select season"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        // Sized like the league switcher: shrinks between two bounds and
        // ellipsises the overflow, so a long season name costs width only where
        // there is width to spare.
        className="border-input bg-background hover:bg-secondary/60 h-8 max-w-[13rem] min-w-[6rem] truncate rounded-md border px-2 text-sm font-medium transition-colors disabled:opacity-60"
      >
        {seasons.map((s) => (
          <option key={s.id} value={s.id}>
            {s.isActive ? `${s.name} (active)` : s.name}
          </option>
        ))}
      </select>
      {/*
        The no-JS path, and a keyboard user's explicit commit. `onChange` above
        submits for everyone else, so this is never the visible control — but a
        select that only works with JS would leave the season unswitchable in
        exactly the conditions where someone is most likely to be debugging one.
      */}
      <button type="submit" className="sr-only">
        Change season
      </button>
    </>
  );
}

/**
 * Season picker for the manage tools. A form, not a link: the choice is stored
 * in a cookie, and only a Server Action can set one — see `selectSeason`.
 *
 * `usePathname()` supplies the return path, so the switcher does not need every
 * page to tell it where it is. Search params are deliberately dropped: the only
 * one that matters here is `?season=`, which would otherwise outrank the cookie
 * that was just written and make the control appear to do nothing.
 */
export function SeasonSelect({
  leagueSlug,
  seasons,
  currentId,
  className,
}: {
  leagueSlug: string;
  seasons: SeasonOption[];
  currentId: string | null;
  className?: string;
}) {
  const pathname = usePathname();
  return (
    <form
      action={selectSeason}
      className={cn("flex min-w-0 items-center", className)}
    >
      <input type="hidden" name="league" value={leagueSlug} />
      <input type="hidden" name="next" value={pathname} />
      <Select seasons={seasons} currentId={currentId} />
    </form>
  );
}

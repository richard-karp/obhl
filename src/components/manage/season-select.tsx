"use client";

import { useFormStatus } from "react-dom";
import { usePathname } from "next/navigation";
import { selectSeason } from "@/lib/actions/season-context";
import { cn } from "@/lib/utils";

export type SeasonOption = { id: string; name: string; isActive: boolean };

// Split out so `useFormStatus` has a form above it. ⛔ No submit button: `requestSubmit()` needs none, and
// its accessible name broke page-scoped `getByRole("button")` queries in the e2e suite.
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
        // Sized like the league switcher: shrinks between two bounds and ellipsises the overflow.
        className="border-input bg-background hover:bg-secondary/60 h-8 max-w-[13rem] min-w-[6rem] truncate rounded-md border px-2 text-sm font-medium transition-colors disabled:opacity-60"
      >
        {seasons.map((s) => (
          <option key={s.id} value={s.id}>
            {s.isActive ? `${s.name} (active)` : s.name}
          </option>
        ))}
      </select>
    </>
  );
}

// A form, not a link: only a Server Action can set the season cookie. Search params are dropped, since
// `?season=` would outrank the cookie just written and the control would seem to do nothing.
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

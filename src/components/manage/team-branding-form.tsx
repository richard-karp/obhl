"use client";

import { useActionState, useState } from "react";
import { updateTeamColor, type TeamActionState } from "@/lib/actions/seasons";
import { TeamLogo } from "@/components/shared/team-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// The chip previews local state, not the saved row: whether the letters read against the colour must be
// answerable before saving.
export function TeamBrandingForm({
  teamId,
  name,
  color,
  logoTextColor,
  logoPath,
}: {
  teamId: string;
  name: string;
  color: string | null;
  logoTextColor: string | null;
  logoPath?: string | null;
}) {
  const [state, action, pending] = useActionState<TeamActionState, FormData>(
    updateTeamColor,
    null,
  );
  // ⚠️ `<input type="color">` has no empty state, so a colourless team shows slate. `touched` stops Save
  // writing that slate as a choice nobody made.
  const [draftColor, setDraftColor] = useState(color ?? "#64748b");
  const [touched, setTouched] = useState(color !== null);
  const [draftInk, setDraftInk] = useState(logoTextColor ?? "light");

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="team_id" value={teamId} />
      {/* An empty `color` is written as null; the visible picker has no `name` until
          touched, so only a deliberate pick submits a hex. */}
      {touched ? null : <input type="hidden" name="color" value="" />}
      {/* `logoPath` not passed: an uploaded image would hide the colour and ink
          this control edits, so the preview stays a monogram. */}
      <TeamLogo name={name} color={draftColor} textColor={draftInk} />
      <Input
        type="color"
        name={touched ? "color" : undefined}
        value={draftColor}
        onChange={(e) => {
          setDraftColor(e.target.value);
          setTouched(true);
        }}
        aria-label={`${name} color`}
        title={`${name} color`}
        className="h-8 w-12 shrink-0 p-1"
      />
      <select
        name="logo_text_color"
        value={draftInk}
        onChange={(e) => setDraftInk(e.target.value)}
        aria-label={`${name} monogram letters`}
        className="border-input bg-background h-8 rounded-md border px-2 text-sm"
      >
        <option value="light">Light letters</option>
        <option value="dark">Dark letters</option>
      </select>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      {state ? (
        <span
          className={
            state.ok
              ? "text-xs text-emerald-600 dark:text-emerald-400"
              : "text-destructive text-xs"
          }
        >
          {state.message}
        </span>
      ) : null}
      {logoPath ? (
        <span className="text-muted-foreground text-xs">
          Logo uploaded — the chip only shows where the image doesn&apos;t.
        </span>
      ) : null}
    </form>
  );
}

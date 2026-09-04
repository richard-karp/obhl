"use client";

import { useActionState, useState } from "react";
import { updateTeamColor, type TeamActionState } from "@/lib/actions/seasons";
import { TeamLogo } from "@/components/shared/team-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * One enrolled team's colour and monogram ink, edited in place beside the team
 * it belongs to.
 *
 * The chip is a live preview off local state rather than the saved row, because
 * the question this control exists to answer — "can I read the letters against
 * that colour?" — cannot be answered by a swatch, and answering it after a round
 * trip means saving something unreadable to find out.
 */
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
  const [draftColor, setDraftColor] = useState(color ?? "#64748b");
  const [draftInk, setDraftInk] = useState(logoTextColor ?? "light");

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="team_id" value={teamId} />
      {/* `logoPath` deliberately not passed: a team with an uploaded logo still
          gets a monogram preview here, because the colour and ink are what this
          control edits and the image would hide both. */}
      <TeamLogo name={name} color={draftColor} textColor={draftInk} />
      <Input
        type="color"
        name="color"
        value={draftColor}
        onChange={(e) => setDraftColor(e.target.value)}
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

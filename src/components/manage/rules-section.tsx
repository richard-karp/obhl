"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";

/**
 * Loaded on demand, not with the page. A static import would put Tiptap and
 * StarterKit into the bundle of the READ view — the page a manager mostly just
 * looks at, and the cost of the merge that would otherwise be paid by everyone
 * entitled to edit whether they edit or not. `@tiptap` has no other importer, so
 * this is the whole of it.
 */
const RulesEditor = dynamic(() =>
  import("./rules-editor").then((m) => m.RulesEditor),
);

/**
 * The rules, as a manager sees them: the published page, with a way into the
 * editor and back out again.
 *
 * `/rules` and `/manage/rules/edit` used to be two URLs over one thing — 29
 * lines and 32, the same heading over the same row of the same table. They are
 * now one page that shows more to whoever is entitled to more.
 *
 * The read view arrives as `children`, already rendered on the server, rather
 * than being rebuilt here. That keeps `RulesRenderer` out of the client bundle
 * and keeps ONE renderer for the public page and the manager's preview of it —
 * a manager editing rules can see exactly what a visitor will see, which is the
 * thing the old split made impossible without opening a second URL.
 *
 * ⛔ Drawn only for a manager, and that is not what makes it safe: `saveRules`
 * calls `requireLeagueManager` itself. See `canManageLeague`.
 */
export function RulesSection({
  leagueId,
  initialContent,
  children,
}: {
  leagueId: string;
  initialContent: unknown;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <div className="space-y-4">
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditing(true)}
          >
            Edit rules
          </Button>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          Editing the rules shown on the public site.
        </p>
        {/*
          "Done" rather than "Cancel": the editor saves through its own button,
          so this only leaves the editing surface. Calling it Cancel would
          promise to undo a save that has already happened.
        */}
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Done
        </Button>
      </div>
      <RulesEditor leagueId={leagueId} initialContent={initialContent} />
    </div>
  );
}

"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";

/** Loaded on demand: a static import would put Tiptap into the read view's bundle. */
const RulesEditor = dynamic(() =>
  import("./rules-editor").then((m) => m.RulesEditor),
);

// The read view arrives as server-rendered `children`: one renderer for the public page and the preview.
// ⛔ Drawn only for a manager, which is not what makes it safe: `saveRules` calls `requireLeagueManager`.
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
          "Done", not "Cancel": the editor saves through its own button, so there is nothing to undo.
        */}
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Done
        </Button>
      </div>
      <RulesEditor leagueId={leagueId} initialContent={initialContent} />
    </div>
  );
}

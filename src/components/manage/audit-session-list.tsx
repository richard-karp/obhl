"use client";

import { useState, useActionState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight } from "lucide-react";

type AuditEntry = {
  id: string;
  created_at: string | null;
  action: string;
  entity_id: string;
  label: string;
  isRevertible: boolean;
};

export type AuditSession = {
  session_id: string | null;
  user_name: string;
  entries: AuditEntry[];
  isCurrentSession: boolean;
};

type RevertResult = { error: string } | { ok: true } | null;
type RevertAction = (_prev: RevertResult, formData: FormData) => Promise<RevertResult>;

function fmt(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function SessionCard({
  session,
  revertAction,
}: {
  session: AuditSession;
  revertAction: RevertAction;
}) {
  const [isOpen, setIsOpen] = useState(session.isCurrentSession);
  const [state, formAction, isPending] = useActionState(revertAction, null);

  const revertible = session.entries.filter((e) => e.isRevertible);
  const readOnly = session.entries.filter((e) => !e.isRevertible);

  const oldest = session.entries[session.entries.length - 1];
  const newest = session.entries[0];
  const timeLabel =
    oldest?.created_at
      ? oldest === newest
        ? fmt(oldest.created_at)
        : `${fmt(oldest.created_at)} – ${newest?.created_at ? fmt(newest.created_at) : ""}`
      : "Unknown time";

  return (
    <Card>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-muted/40 transition-colors rounded-t-lg"
        onClick={() => setIsOpen((o) => !o)}
      >
        {isOpen ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium text-sm">{session.user_name}</span>
        <span className="text-muted-foreground text-sm">
          {session.entries.length} action{session.entries.length !== 1 ? "s" : ""}
        </span>
        {session.isCurrentSession && (
          <span className="text-xs bg-primary/10 text-primary rounded px-1.5 py-0.5 font-medium">
            current session
          </span>
        )}
        <span className="text-muted-foreground text-xs ml-auto">{timeLabel}</span>
      </button>

      {isOpen && (
        <CardContent className="px-4 pb-4 pt-0 border-t">
          <form action={formAction} className="space-y-1 pt-3">
            {revertible.map((entry) => (
              <label
                key={entry.id}
                className="flex items-center gap-3 cursor-pointer rounded px-2 py-1.5 hover:bg-muted/30"
              >
                <input
                  type="checkbox"
                  name="auditId"
                  value={entry.id}
                  defaultChecked
                  className="h-4 w-4 accent-primary shrink-0"
                />
                <span className="text-sm flex-1">{entry.label}</span>
                {entry.created_at && (
                  <span className="text-muted-foreground text-xs shrink-0">
                    {fmt(entry.created_at)}
                  </span>
                )}
              </label>
            ))}

            {readOnly.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-3 px-2 py-1.5 opacity-40"
              >
                <div className="h-4 w-4 shrink-0" />
                <span className="text-sm flex-1">{entry.label}</span>
                {entry.created_at && (
                  <span className="text-muted-foreground text-xs shrink-0">
                    {fmt(entry.created_at)}
                  </span>
                )}
              </div>
            ))}

            {revertible.length > 0 && (
              <div className="pt-3 flex items-center gap-3">
                <Button
                  type="submit"
                  variant="destructive"
                  size="sm"
                  disabled={isPending}
                >
                  {isPending ? "Reverting…" : "Revert selected"}
                </Button>
                {"error" in (state ?? {}) && (
                  <p className="text-destructive text-sm">
                    {(state as { error: string }).error}
                  </p>
                )}
                {"ok" in (state ?? {}) && (
                  <p className="text-sm text-green-600 dark:text-green-400">
                    Reverted successfully.
                  </p>
                )}
              </div>
            )}
          </form>
        </CardContent>
      )}
    </Card>
  );
}

export function AuditSessionList({
  sessions,
  revertAction,
}: {
  sessions: AuditSession[];
  revertAction: RevertAction;
}) {
  if (sessions.length === 0) return null;

  return (
    <div className="space-y-3">
      {sessions.map((session) => (
        <SessionCard
          key={session.session_id ?? "__none__"}
          session={session}
          revertAction={revertAction}
        />
      ))}
    </div>
  );
}

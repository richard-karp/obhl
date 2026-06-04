"use client";

import { useActionState } from "react";
import {
  createAnnouncement,
  type AnnouncementActionState,
} from "@/lib/actions/announcements";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AnnouncementForm() {
  const [state, action, pending] = useActionState<
    AnnouncementActionState,
    FormData
  >(createAnnouncement, null);

  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" required placeholder="Playoffs start June 22" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="body">Message</Label>
        <textarea
          id="body"
          name="body"
          required
          rows={3}
          placeholder="Write the announcement…"
          className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Posting…" : "Post announcement"}
        </Button>
        {state ? (
          <p
            className={
              state.ok
                ? "text-sm text-emerald-600 dark:text-emerald-400"
                : "text-destructive text-sm"
            }
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { uploadTeamLogo, type LogoActionState } from "@/lib/actions/logos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LOGO_ACCEPT } from "@/lib/utils/logo-type";

export function LogoUpload({ teamId }: { teamId: string }) {
  const [state, action, pending] = useActionState<LogoActionState, FormData>(
    uploadTeamLogo,
    null,
  );

  return (
    <div className="space-y-1">
      <form action={action} className="flex items-end gap-2">
        <input type="hidden" name="team_id" value={teamId} />
        <Input
          type="file"
          name="logo"
          accept={LOGO_ACCEPT}
          className="max-w-xs"
          required
        />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          Upload logo
        </Button>
      </form>
      {state ? (
        <p
          role={state.ok ? "status" : "alert"}
          className={
            state.ok ? "text-muted-foreground text-sm" : "text-destructive text-sm"
          }
        >
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
